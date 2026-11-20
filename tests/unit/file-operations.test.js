import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const previousWorkspace = process.env.PULS_AI_WORKSPACE;
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "puls-ai-file-ops-"));
process.env.PULS_AI_WORKSPACE = workspace;
await fs.writeFile(path.join(workspace, "source.txt"), "keep this file", "utf8");

const { applyFileOperationsTool, prepareFileOperations, formatFileDiff, resolveWorkspacePath, replaceFileAtomically } = await import("../../src/tools/files/file.tools.js");
const rl = (await import("../../src/ui/readline.js")).default;

after(async () => {
    rl.close();
    await fs.rm(workspace, { recursive: true, force: true });
    if (previousWorkspace === undefined) delete process.env.PULS_AI_WORKSPACE;
    else process.env.PULS_AI_WORKSPACE = previousWorkspace;
});

test("rejects duplicate moves of one source before asking for approval", async () => {
    await assert.rejects(
        applyFileOperationsTool.invoke({
            operations: [
                { type: "move_file", source: "source.txt", destination: "first" },
                { type: "move_file", source: "source.txt", destination: "second" },
            ],
        }),
        /conflicting operations for move source/i
    );

    assert.equal(await fs.readFile(path.join(workspace, "source.txt"), "utf8"), "keep this file");
    await assert.rejects(fs.access(path.join(workspace, "first")));
    await assert.rejects(fs.access(path.join(workspace, "second")));
});

test("shows removed and added lines before replacement without writing", async () => {
    const [operation] = await prepareFileOperations([
        { type: "write_file", path: "source.txt", content: "replacement content", mode: "replace" },
    ]);
    assert.match(operation.plan, /--- source\.txt/);
    assert.match(operation.plan, /-keep this file/);
    assert.match(operation.plan, /\+replacement content/);
    assert.equal(await fs.readFile(path.join(workspace, "source.txt"), "utf8"), "keep this file");
});

test("bounds large diff previews", () => {
    const preview = formatFileDiff("before", Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n"), "large.txt");
    assert.match(preview, /Diff preview truncated/);
    assert.ok(preview.split("\n").length <= 121);
    assert.ok(Buffer.byteLength(preview) < 17 * 1024);
});

test("omits credential contents from approval plans", async () => {
    const [operation] = await prepareFileOperations([
        { type: "write_file", path: ".env", content: "API_KEY=never-display-this", mode: "create" },
    ]);
    assert.match(operation.plan, /content preview omitted/);
    assert.doesNotMatch(operation.plan, /never-display-this/);
});

test("writes an approved batch and preserves operation order", async () => {
    let approvals = 0;
    const result = await applyFileOperationsTool.invoke({
        operations: [
            { type: "create_directory", path: "approved" },
            { type: "write_file", path: "approved/new.txt", content: "created after approval", mode: "create" },
        ],
    }, { configurable: { askPermission: async (_action, details) => {
        approvals += 1;
        assert.match(details, /CREATE DIRECTORY/);
        assert.match(details, /\+created after approval/);
        await assert.rejects(fs.access(path.join(workspace, "approved")));
        return true;
    } } });
    assert.equal(approvals, 1);
    assert.match(result, /Approved batch completed \(2\/2 operations\)/);
    assert.equal(await fs.readFile(path.join(workspace, "approved/new.txt"), "utf8"), "created after approval");
});

test("denied batches leave every path untouched", async () => {
    const result = await applyFileOperationsTool.invoke({
        operations: [{ type: "write_file", path: "denied.txt", content: "never written", mode: "create" }],
    }, { configurable: { askPermission: async () => false } });
    assert.match(result, /Cancelled/);
    await assert.rejects(fs.access(path.join(workspace, "denied.txt")));
});

test("refuses replacement when content changes during approval", async () => {
    const target = path.join(workspace, "changed-during-approval.txt");
    await fs.writeFile(target, "original");
    const result = await applyFileOperationsTool.invoke({
        operations: [{ type: "write_file", path: path.basename(target), content: "proposed", mode: "replace" }],
    }, { configurable: { askPermission: async () => {
        await fs.writeFile(target, "external edit");
        return true;
    } } });
    assert.match(result, /changed after the preview/);
    assert.equal(await fs.readFile(target, "utf8"), "external edit");
});

test("refuses a create destination that appears during approval", async () => {
    const target = path.join(workspace, "appeared-during-approval.txt");
    const result = await applyFileOperationsTool.invoke({
        operations: [{ type: "write_file", path: path.basename(target), content: "proposed", mode: "create" }],
    }, { configurable: { askPermission: async () => {
        await fs.writeFile(target, "external file");
        return true;
    } } });
    assert.match(result, /File appeared after approval/);
    assert.equal(await fs.readFile(target, "utf8"), "external file");
});

test("cancels before executing approved operations", async () => {
    const controller = new AbortController();
    await assert.rejects(applyFileOperationsTool.invoke({
        operations: [{ type: "write_file", path: "cancelled.txt", content: "never written", mode: "create" }],
    }, { signal: controller.signal, configurable: { askPermission: async () => {
        controller.abort();
        return true;
    } } }), { name: "AbortError" });
    await assert.rejects(fs.access(path.join(workspace, "cancelled.txt")));
});

test("rejects paths containing terminal controls", async () => {
    await assert.rejects(resolveWorkspacePath("bad\u001b[2J.txt", { allowMissing: true }), /control characters/);
});

test("rejects Windows alternate streams, device names and trailing aliases", { skip: process.platform !== "win32" }, async () => {
    for (const filePath of ["source.txt:secret", "NUL.txt", "folder/new.txt.", "not-created/COM1.log"]) {
        await assert.rejects(resolveWorkspacePath(filePath, { allowMissing: true }), /Unsupported Windows file path/);
    }
});

test("blocks parent symlinks even when they resolve inside the workspace", async (context) => {
    const directory = path.join(workspace, "real-folder");
    const alias = path.join(workspace, "alias-folder");
    await fs.mkdir(directory);
    try { await fs.symlink(directory, alias, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { context.skip("Symlink creation is unavailable"); return; } throw error; }
    await assert.rejects(resolveWorkspacePath("alias-folder/new.txt", { allowMissing: true }), /Symbolic links are not allowed/);
});

test("refuses replacing multiply-linked files", async () => {
    const original = path.join(workspace, "hard-link-source.txt");
    await fs.writeFile(original, "retain both copies");
    await fs.link(original, path.join(workspace, "hard-link-target.txt"));
    await assert.rejects(prepareFileOperations([
        { type: "write_file", path: "hard-link-target.txt", content: "change", mode: "replace" },
    ]), /multiple hard links/);
    assert.equal(await fs.readFile(original, "utf8"), "retain both copies");
});

test("validates conflicting ancestor paths before approval", async () => {
    for (const operations of [
        [
            { type: "write_file", path: "conflict", content: "file", mode: "create" },
            { type: "write_file", path: "conflict/nested.txt", content: "child", mode: "create" },
        ],
        [
            { type: "write_file", path: "conflict/nested.txt", content: "child", mode: "create" },
            { type: "write_file", path: "conflict", content: "file", mode: "create" },
        ],
    ]) {
        await assert.rejects(prepareFileOperations(operations), /conflicting file and directory paths/);
    }
    await assert.rejects(fs.access(path.join(workspace, "conflict")));
});

test("moves an approved file without overwriting another file", async () => {
    await fs.writeFile(path.join(workspace, "move-me.txt"), "move content");
    const result = await applyFileOperationsTool.invoke({ operations: [
        { type: "move_file", source: "move-me.txt", destination: "move-target" },
    ] }, { configurable: { askPermission: async () => true } });
    assert.match(result, /Moved file/);
    assert.equal(await fs.readFile(path.join(workspace, "move-target/move-me.txt"), "utf8"), "move content");
    await assert.rejects(fs.access(path.join(workspace, "move-me.txt")));
});

test("retains a move source changed during approval", async () => {
    const source = path.join(workspace, "changed-move.txt");
    await fs.writeFile(source, "original");
    const result = await applyFileOperationsTool.invoke({ operations: [
        { type: "move_file", source: "changed-move.txt", destination: "changed-move-target" },
    ] }, { configurable: { askPermission: async () => {
        await fs.writeFile(source, "new external content");
        return true;
    } } });
    assert.match(result, /Move source changed after the preview/);
    assert.equal(await fs.readFile(source, "utf8"), "new external content");
    await assert.rejects(fs.access(path.join(workspace, "changed-move-target/changed-move.txt")));
});

async function replacement(name, original = 'original contents', content = 'replacement contents') {
    const target = path.join(workspace, name);
    await fs.writeFile(target, original);
    const [operation] = await prepareFileOperations([{ type: 'write_file', path: name, content, mode: 'replace' }]);
    return { target, operation };
}

function stagedFileSystem(write) {
    return {
        ...fs,
        open: async (...args) => {
            const handle = await fs.open(...args);
            return new Proxy(handle, {
                get(target, property) {
                    if (property === 'writeFile') return (...values) => write(target, ...values);
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        },
    };
}

async function assertNoStagingFiles() {
    assert.deepEqual((await fs.readdir(workspace)).filter((name) => name.startsWith('.puls-write-')), []);
}

test('approved replacements commit complete content through a separate file', async () => {
    const { target } = await replacement('atomic-success.txt');
    const before = await fs.stat(target);
    const result = await applyFileOperationsTool.invoke({ operations: [
        { type: 'write_file', path: path.basename(target), content: 'approved replacement', mode: 'replace' },
    ] }, { configurable: { askPermission: async () => true } });
    assert.match(result, /Approved batch completed/);
    assert.equal(await fs.readFile(target, 'utf8'), 'approved replacement');
    const after = await fs.stat(target);
    if (before.ino && after.ino) assert.notEqual(after.ino, before.ino);
    await assertNoStagingFiles();
});

test('atomic replacement preserves POSIX file permissions', { skip: process.platform === 'win32' }, async () => {
    const { target, operation } = await replacement('atomic-permissions.txt');
    await fs.chmod(target, 0o640);
    await replaceFileAtomically(operation);
    assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
});

test('partial staging write failures leave the original intact and remove temporary files', async () => {
    const { target, operation } = await replacement('atomic-write-failure.txt');
    const fileSystem = stagedFileSystem(async (handle) => {
        await handle.writeFile('partial staged output');
        throw Object.assign(new Error('Simulated disk full'), { code: 'ENOSPC' });
    });
    await assert.rejects(replaceFileAtomically(operation, { fileSystem }), { code: 'ENOSPC' });
    assert.equal(await fs.readFile(target, 'utf8'), 'original contents');
    await assertNoStagingFiles();
});

test('failed atomic commit leaves the approved original intact', async () => {
    const { target, operation } = await replacement('atomic-commit-failure.txt');
    await assert.rejects(replaceFileAtomically(operation, { fileSystem: {
        ...fs, rename: async () => { throw Object.assign(new Error('Simulated locked destination'), { code: 'EPERM' }); },
    } }), { code: 'EPERM' });
    assert.equal(await fs.readFile(target, 'utf8'), 'original contents');
    await assertNoStagingFiles();
});

test('edits made while the replacement is being staged are retained', async () => {
    const { target, operation } = await replacement('atomic-concurrent-edit.txt');
    const fileSystem = stagedFileSystem(async (handle, ...args) => {
        await handle.writeFile(...args);
        await fs.writeFile(target, 'concurrent external edit');
    });
    await assert.rejects(replaceFileAtomically(operation, { fileSystem }), /changed after the preview/);
    assert.equal(await fs.readFile(target, 'utf8'), 'concurrent external edit');
    await assertNoStagingFiles();
});

test('cancellation after staging retains the original and removes the temporary file', async () => {
    const { target, operation } = await replacement('atomic-cancelled.txt');
    const controller = new AbortController();
    const fileSystem = stagedFileSystem(async (handle, ...args) => {
        await handle.writeFile(...args);
        controller.abort();
    });
    await assert.rejects(replaceFileAtomically(operation, { signal: controller.signal, fileSystem }), { name: 'AbortError' });
    assert.equal(await fs.readFile(target, 'utf8'), 'original contents');
    await assertNoStagingFiles();
});

test('confirmed operation events survive a later partial-batch failure', async () => {
    const events = [];
    const result = await applyFileOperationsTool.invoke({ operations: [
        { type: 'write_file', path: 'progress-first.txt', content: 'first commit', mode: 'create' },
        { type: 'write_file', path: 'progress-second.txt', content: 'never overwrite', mode: 'create' },
    ] }, { configurable: {
        askPermission: async () => true,
        onFileOperation: async (event) => {
            events.push(event);
            await fs.writeFile(path.join(workspace, 'progress-second.txt'), 'external file');
        },
    } });
    assert.match(result, /Batch stopped/);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { type: 'write_file', path: path.join(workspace, 'progress-first.txt'), mode: 'create', status: 'complete' });
    assert.equal(await fs.readFile(path.join(workspace, 'progress-first.txt'), 'utf8'), 'first commit');
    assert.equal(await fs.readFile(path.join(workspace, 'progress-second.txt'), 'utf8'), 'external file');
});

test('presentation callback failures do not invalidate committed changes', async () => {
    const result = await applyFileOperationsTool.invoke({ operations: [
        { type: 'write_file', path: 'progress-callback-failure.txt', content: 'committed', mode: 'create' },
    ] }, { configurable: { askPermission: async () => true, onFileOperation: async () => { throw new Error('Renderer unavailable'); } } });
    assert.match(result, /Approved batch completed/);
    assert.equal(await fs.readFile(path.join(workspace, 'progress-callback-failure.txt'), 'utf8'), 'committed');
});
