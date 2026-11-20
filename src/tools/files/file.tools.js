import { tool } from "@langchain/core/tools";
import * as z from "zod"
import fs from "fs/promises"
import { constants as fsConstants, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import path from "path"
import { askPermission } from "../../security/permission.prompt.js";

// The CLI uses the directory it was launched from as its workspace by default.
// Set PULS_AI_WORKSPACE to use a different workspace root.
const WORKSPACE_ROOT = path.resolve(
    process.env.PULS_AI_WORKSPACE || process.cwd()
);

function isWithinWorkspace(root, target) {
    const relativePath = path.relative(root, target);
    return relativePath === "" || (
        relativePath !== ".." &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativePath)
    );
}

/**
 * Validate a user-supplied path against the active workspace. Existing paths
 * and the nearest existing parent are resolved to detect symlink escapes.
 */
export async function resolveWorkspacePath(inputPath, { allowMissing = false } = {}) {
    if (typeof inputPath !== "string" || inputPath.trim() === "") {
        throw new Error("A non-empty file path is required.");
    }
    if (/[\u0000-\u001f\u007f]/u.test(inputPath)) {
        throw new Error("File paths cannot contain control characters.");
    }

    const root = await fs.realpath(WORKSPACE_ROOT);
    const candidatePath = path.resolve(root, inputPath);

    if (!isWithinWorkspace(root, candidatePath)) {
        throw new Error(`Path is outside the active workspace: ${inputPath}`);
    }

    const parts = path.relative(root, candidatePath).split(path.sep).filter(Boolean);
    for (const part of parts) {
        // Win32 device names, alternate streams and trailing-dot aliases do not
        // name ordinary files even when they appear to be within the workspace.
        if (process.platform === "win32" && (
            /[<>:"|?*]/u.test(part) || /[. ]$/u.test(part) ||
            /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
        )) {
            throw new Error(`Unsupported Windows file path component: ${part}`);
        }
    }
    let currentPath = root;
    for (const part of parts) {
        currentPath = path.join(currentPath, part);
        try {
            const stats = await fs.lstat(currentPath);
            if (stats.isSymbolicLink()) {
                throw new Error(`Symbolic links are not allowed in workspace paths: ${inputPath}`);
            }
        } catch (error) {
            if (error.code === "ENOENT" && allowMissing) break;
            throw error;
        }
    }

    if (!allowMissing) {
        const actualPath = await fs.realpath(candidatePath);
        if (!isWithinWorkspace(root, actualPath)) {
            throw new Error(`Path resolves outside the active workspace: ${inputPath}`);
        }
        return candidatePath;
    }

    let ancestor = candidatePath;
    const missingParts = [];

    while (true) {
        try {
            const actualAncestor = await fs.realpath(ancestor);
            if (!isWithinWorkspace(root, actualAncestor)) {
                throw new Error(`Path resolves outside the active workspace: ${inputPath}`);
            }

            const resolvedCandidate = path.resolve(actualAncestor, ...missingParts);
            if (!isWithinWorkspace(root, resolvedCandidate)) {
                throw new Error(`Path resolves outside the active workspace: ${inputPath}`);
            }

            return candidatePath;
        } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;

            const parent = path.dirname(ancestor);
            if (parent === ancestor) {
                throw new Error(`Could not validate path inside the active workspace: ${inputPath}`);
            }

            missingParts.unshift(path.basename(ancestor));
            ancestor = parent;
        }
    }
}

const MAX_READ_LINES = 400;
const MAX_READ_BYTES = 48 * 1024;
const MAX_LINE_SCAN = 20_000;
const MAX_READ_SCAN_BYTES = 256 * 1024;
const MAX_DIRECTORY_RESULTS = 200;
const MAX_DIFF_BYTES = 16 * 1024;
const MAX_DIFF_LINES = 120;
const MAX_PREVIEW_BYTES = 64 * 1024;

/** A bounded unified-style diff; unchanged surrounding content is omitted. */
export function formatFileDiff(before, after, filePath, { previewTruncated = false } = {}) {
    const previous = before === "" ? [] : before.replace(/\r\n/g, "\n").split("\n");
    const next = after === "" ? [] : after.replace(/\r\n/g, "\n").split("\n");
    let start = 0;
    while (start < previous.length && start < next.length && previous[start] === next[start]) start += 1;
    if (start === previous.length && start === next.length && !previewTruncated) return "No content changes.";
    let oldEnd = previous.length;
    let newEnd = next.length;
    while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) {
        oldEnd -= 1;
        newEnd -= 1;
    }
    const lines = [`--- ${before ? filePath : "/dev/null"}`, `+++ ${filePath}`, `@@ -${start + 1},${oldEnd - start} +${start + 1},${newEnd - start} @@`];
    let bytes = Buffer.byteLength(lines.join("\n"));
    const append = (prefix, content) => {
        const line = `${prefix}${content}`;
        const size = Buffer.byteLength(line) + 1;
        if (lines.length >= MAX_DIFF_LINES || bytes + size > MAX_DIFF_BYTES) return false;
        lines.push(line);
        bytes += size;
        return true;
    };
    let truncated = previewTruncated;
    for (let index = start; index < oldEnd; index += 1) {
        if (!append("-", previous[index])) { truncated = true; break; }
    }
    for (let index = start; index < newEnd; index += 1) {
        if (!append("+", next[index])) { truncated = true; break; }
    }
    if (truncated) lines.push("[Diff preview truncated; review the full file before approving large changes.]");
    return lines.join("\n");
}

async function snapshotFile(filePath, signal) {
    signal?.throwIfAborted();
    const hash = createHash("sha256");
    const preview = [];
    let previewSize = 0;
    const input = createReadStream(filePath, { signal });
    try {
        for await (const chunk of input) {
            signal?.throwIfAborted();
            hash.update(chunk);
            if (previewSize < MAX_PREVIEW_BYTES) {
                const selected = chunk.subarray(0, MAX_PREVIEW_BYTES - previewSize);
                preview.push(selected);
                previewSize += selected.length;
            }
        }
    } finally {
        input.destroy();
    }
    signal?.throwIfAborted();
    return { digest: hash.digest("hex"), preview: Buffer.concat(preview).toString("utf8") };
}

function isSensitiveFile(filePath) {
    const segments = filePath.split(path.sep).map((part) => part.toLowerCase());
    const name = path.basename(filePath).toLowerCase();
    const sensitiveDirectories = new Set([".ssh", ".aws", ".azure", ".gnupg", ".puls-ai", ".kube"]);

    return segments.some((part) => sensitiveDirectories.has(part)) ||
        /^\.env(?:\..*)?$/.test(name) ||
        [".npmrc", ".pypirc", ".git-credentials", ".netrc", "_netrc"].includes(name) ||
        /^(?:credentials?|secrets?)(?:[._-].*)?$/.test(name) ||
        /^id_(?:rsa|ed25519)(?:[._-].*)?$/.test(name) ||
        /\.(?:pem|key|p12|pfx|keystore)$/.test(name);
}

/** Read a small, numbered text range from inside the active workspace. */
export const readFileTool = tool(
    async ({ path: inputPath, startLine = 1, endLine }, config) => {
        const signal = config?.signal;
        signal?.throwIfAborted();
        if (endLine !== undefined && endLine < startLine) {
            throw new Error("endLine must be greater than or equal to startLine.");
        }
        if (startLine > MAX_LINE_SCAN) {
            throw new Error(`startLine exceeds the scan limit (${MAX_LINE_SCAN}). Request a lower line range.`);
        }
        if (endLine !== undefined && endLine - startLine + 1 > MAX_READ_LINES) {
            throw new Error(`A read request can return at most ${MAX_READ_LINES} lines. Narrow the requested range.`);
        }

        const safePath = await resolveWorkspacePath(inputPath);
        if (isSensitiveFile(safePath)) {
            throw new Error("Reading this credential or secret file is blocked by default.");
        }

        const stats = await fs.lstat(safePath);
        signal?.throwIfAborted();
        if (stats.isSymbolicLink()) {
            throw new Error("Reading symbolic links is not allowed.");
        }
        if (!stats.isFile()) {
            throw new Error("readFile only supports regular files.");
        }
        if (stats.size === 0) {
            return `File is empty: ${safePath}`;
        }

        // Opening before constructing readline makes EACCES/ENOENT reject this
        // tool call instead of becoming an unhandled input-stream error.
        const handle = await fs.open(safePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const scanLimitHit = stats.size > MAX_READ_SCAN_BYTES;
        const input = handle.createReadStream({
            encoding: "utf8",
            end: Math.min(stats.size, MAX_READ_SCAN_BYTES) - 1,
            autoClose: false,
            signal,
        });
        const lines = createInterface({ input, crlfDelay: Infinity });
        let inputError;
        input.on("error", (error) => { inputError = error; lines.close(); });
        const selected = [];
        let currentLine = 0;
        let outputBytes = 0;
        let truncated = false;
        let lastSelectedLine = startLine - 1;

        try {
            for await (const line of lines) {
                signal?.throwIfAborted();
                currentLine += 1;

                if (currentLine > MAX_LINE_SCAN) {
                    truncated = true;
                    break;
                }
                if (currentLine < startLine) continue;
                if (endLine !== undefined && currentLine > endLine) break;
                if (line.includes("\0")) {
                    throw new Error("Binary files are not supported by readFile.");
                }

                const numberedLine = `${currentLine}: ${line}`;
                const lineBytes = Buffer.byteLength(numberedLine, "utf8") + 1;
                if (selected.length >= MAX_READ_LINES || outputBytes + lineBytes > MAX_READ_BYTES) {
                    truncated = true;
                    break;
                }

                selected.push(numberedLine);
                outputBytes += lineBytes;
                lastSelectedLine = currentLine;

                if (selected.length === MAX_READ_LINES) {
                    truncated = endLine === undefined || currentLine < endLine;
                    break;
                }
            }
        } finally {
            lines.close();
            input.destroy();
            await handle.close();
        }
        signal?.throwIfAborted();
        if (inputError) throw inputError;

        if (scanLimitHit && (endLine === undefined || lastSelectedLine < endLine)) {
            truncated = true;
        }

        if (selected.length === 0) {
            return truncated
                ? `No lines were returned before the read limits (${MAX_READ_LINES} lines, ${MAX_READ_BYTES} output bytes, ${MAX_READ_SCAN_BYTES} scanned bytes). Request a smaller range from ${safePath}.`
                : `No content found in lines ${startLine}${endLine === undefined ? " onward" : `-${endLine}`} of ${safePath}.`;
        }

        const header = `File: ${safePath}\nLines: ${startLine}-${lastSelectedLine}\n`;
        const footer = truncated
            ? `\n[Output truncated at ${MAX_READ_LINES} lines, ${MAX_READ_BYTES} output bytes, ${MAX_LINE_SCAN} scanned lines, or ${MAX_READ_SCAN_BYTES} scanned bytes. Request a narrower range.]`
            : "";
        return `${header}\n${selected.join("\n")}${footer}`;
    },
    {
        name: "readFile",
        description: `Read a text file or a specific numbered line range inside the active workspace. Use before proposing code edits. Credential files such as .env, .npmrc, private keys, and files in .ssh/.aws/.azure are blocked. Output is capped at ${MAX_READ_LINES} lines and ${MAX_READ_BYTES} bytes; scanning stops at ${MAX_READ_SCAN_BYTES} bytes.`,
        schema: z.object({
            path: z.string().min(1).describe("File path inside the active workspace; relative paths are recommended"),
            startLine: z.number().int().min(1).optional().describe("First line to return; defaults to 1"),
            endLine: z.number().int().min(1).optional().describe(`Last line to return; must be within ${MAX_READ_LINES} lines of startLine`),
        }),
    }
);

const fileOperationSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("write_file"),
        path: z.string().min(1).describe("File path inside the active workspace"),
        content: z.string().describe("Complete file contents to write"),
        mode: z.enum(["create", "replace"]).default("create").describe("Use create for a new file; use replace only when the user asked to change an existing file"),
    }),
    z.object({
        type: z.literal("create_directory"),
        path: z.string().min(1).describe("Directory path inside the active workspace"),
    }),
    z.object({
        type: z.literal("move_file"),
        source: z.string().min(1).describe("Existing file path inside the active workspace"),
        destination: z.string().min(1).describe("Destination directory inside the active workspace"),
    }),
]);

function operationPathKey(targetPath) {
    const normalized = path.resolve(targetPath);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function lstatIfPresent(targetPath) {
    try {
        return await fs.lstat(targetPath);
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

function assertNotSymlink(stats, targetPath) {
    if (stats?.isSymbolicLink()) {
        throw new Error(`Symbolic links are not accepted for batch mutations: ${targetPath}`);
    }
}

async function assertOriginalFile(operation, signal) {
    signal?.throwIfAborted();
    await resolveWorkspacePath(operation.targetPath);
    const current = await fs.lstat(operation.targetPath);
    assertNotSymlink(current, operation.targetPath);
    if (!current.isFile() || current.nlink > 1 ||
        current.dev !== operation.originalIdentity.dev || current.ino !== operation.originalIdentity.ino ||
        (await snapshotFile(operation.targetPath, signal)).digest !== operation.originalDigest) {
        throw new Error(`File changed after the preview; refusing to replace: ${operation.targetPath}`);
    }
    signal?.throwIfAborted();
    return current;
}

/** Stage a full replacement before touching the approved original. */
export async function replaceFileAtomically(operation, { signal, fileSystem = fs } = {}) {
    await assertOriginalFile(operation, signal);
    const temporaryPath = path.join(path.dirname(operation.targetPath), `.puls-write-${randomUUID()}.tmp`);
    let handle;
    let ownsTemporaryFile = false;
    try {
        await resolveWorkspacePath(temporaryPath, { allowMissing: true });
        signal?.throwIfAborted();
        // Never open a pre-existing staging file or follow a staging symlink.
        handle = await fileSystem.open(temporaryPath, "wx", 0o600);
        ownsTemporaryFile = true;
        await handle.writeFile(operation.content, { encoding: "utf8", signal });
        const current = await assertOriginalFile(operation, signal);
        if (process.platform !== "win32") {
            const staged = await handle.stat();
            if (staged.uid !== current.uid || staged.gid !== current.gid) await handle.chown(current.uid, current.gid);
        }
        await handle.chmod(current.mode & 0o7777);
        await handle.sync();
        await handle.close();
        handle = undefined;
        // Review-time checks are repeated after staging: concurrent edits must
        // remain intact even if writing/flushing the replacement took a while.
        await assertOriginalFile(operation, signal);
        await resolveWorkspacePath(temporaryPath);
        signal?.throwIfAborted();
        await fileSystem.rename(temporaryPath, operation.targetPath);
        ownsTemporaryFile = false;
    } finally {
        try { await handle?.close(); }
        finally {
            if (ownsTemporaryFile) await fileSystem.rm(temporaryPath, { force: true });
        }
    }
}

export async function prepareFileOperations(operations, { signal } = {}) {
    const prepared = [];
    const plannedTargets = new Set();
    const plannedFiles = new Set();
    const plannedSources = new Set();

    function reserveTarget(targetPath, { directory = false } = {}) {
        const key = operationPathKey(targetPath);
        if (plannedTargets.has(key) || plannedSources.has(key)) {
            throw new Error(`The batch contains conflicting operations for: ${targetPath}`);
        }
        for (const existing of plannedTargets) {
            if ((plannedFiles.has(existing) && isWithinWorkspace(existing, key)) ||
                (!directory && isWithinWorkspace(key, existing))) {
                throw new Error(`The batch contains conflicting file and directory paths: ${targetPath}`);
            }
        }
        plannedTargets.add(key);
        if (!directory) plannedFiles.add(key);
    }

    for (const operation of operations) {
        signal?.throwIfAborted();
        if (operation.type === "write_file") {
            const targetPath = await resolveWorkspacePath(operation.path, { allowMissing: true });
            const existing = await lstatIfPresent(targetPath);
            assertNotSymlink(existing, targetPath);

            if (operation.mode === "create" && existing) {
                throw new Error(`File already exists; refusing to overwrite: ${targetPath}`);
            }
            if (operation.mode === "replace" && (!existing || !existing.isFile())) {
                throw new Error(`Replace requires an existing regular file: ${targetPath}`);
            }
            if (existing?.nlink > 1) {
                throw new Error(`Refusing to replace a file with multiple hard links: ${targetPath}`);
            }

            reserveTarget(targetPath);
            const original = existing ? await snapshotFile(targetPath, signal) : null;
            const sensitive = isSensitiveFile(targetPath);
            const nextPreview = Buffer.from(operation.content, "utf8").subarray(0, MAX_PREVIEW_BYTES).toString("utf8");
            const preview = sensitive
                ? "[Credential or secret file: content preview omitted.]"
                : original?.preview.includes("\0") || nextPreview.includes("\0")
                    ? "[Binary content: text diff unavailable.]"
                    : formatFileDiff(original?.preview ?? "", nextPreview, path.relative(WORKSPACE_ROOT, targetPath), {
                        previewTruncated: Boolean(existing?.size > MAX_PREVIEW_BYTES || Buffer.byteLength(operation.content) > MAX_PREVIEW_BYTES),
                    });
            prepared.push({
                ...operation,
                targetPath,
                originalDigest: original?.digest,
                originalIdentity: existing && { dev: existing.dev, ino: existing.ino },
                plan: `${operation.mode === "replace" ? "REPLACE FILE" : "CREATE FILE"}: ${targetPath}\n   ${Buffer.byteLength(operation.content, "utf8")} bytes; parent folders will be created if needed\n${preview}`,
            });
            continue;
        }

        if (operation.type === "create_directory") {
            const targetPath = await resolveWorkspacePath(operation.path, { allowMissing: true });
            const existing = await lstatIfPresent(targetPath);
            assertNotSymlink(existing, targetPath);
            if (existing && !existing.isDirectory()) {
                throw new Error(`A non-directory already exists at: ${targetPath}`);
            }

            if (existing) {
                prepared.push({ ...operation, targetPath, noOp: true, plan: `NO CHANGE (directory exists): ${targetPath}` });
            } else {
                reserveTarget(targetPath, { directory: true });
                prepared.push({ ...operation, targetPath, plan: `CREATE DIRECTORY: ${targetPath} (including missing parent folders)` });
            }
            continue;
        }

        const sourcePath = await resolveWorkspacePath(operation.source);
        const sourceKey = operationPathKey(sourcePath);
        if (plannedSources.has(sourceKey) || plannedTargets.has(sourceKey)) {
            throw new Error(`The batch contains conflicting operations for move source: ${sourcePath}`);
        }
        plannedSources.add(sourceKey);
        const sourceStats = await lstatIfPresent(sourcePath);
        assertNotSymlink(sourceStats, sourcePath);
        if (!sourceStats?.isFile()) {
            throw new Error(`Move source must be an existing regular file: ${sourcePath}`);
        }
        if (/^\.[^.]+$/.test(path.basename(sourcePath))) {
            throw new Error(`Refusing to move extension-only hidden file: ${sourcePath}`);
        }

        const destinationDirectory = await resolveWorkspacePath(operation.destination, { allowMissing: true });
        const destinationStats = await lstatIfPresent(destinationDirectory);
        assertNotSymlink(destinationStats, destinationDirectory);
        if (destinationStats && !destinationStats.isDirectory()) {
            throw new Error(`Move destination must be a directory: ${destinationDirectory}`);
        }

        const destinationPath = await resolveWorkspacePath(
            path.join(destinationDirectory, path.basename(sourcePath)),
            { allowMissing: true }
        );
        if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
            throw new Error(`Source and destination are the same: ${sourcePath}`);
        }
        if (await lstatIfPresent(destinationPath)) {
            throw new Error(`Move would overwrite an existing path: ${destinationPath}`);
        }

        reserveTarget(destinationPath);
        prepared.push({
            ...operation,
            sourcePath,
            destinationDirectory,
            destinationPath,
            originalDigest: (await snapshotFile(sourcePath, signal)).digest,
            originalIdentity: { dev: sourceStats.dev, ino: sourceStats.ino },
            plan: `MOVE FILE: ${sourcePath}\n   TO: ${destinationPath}${destinationStats ? "" : "\n   Destination folder will be created if needed"}`,
        });
    }

    return prepared;
}

/** One approval for the complete set of proposed file mutations. */
export const applyFileOperationsTool = tool(
    async ({ operations }, config) => {
        config?.signal?.throwIfAborted();
        const prepared = await prepareFileOperations(operations, { signal: config?.signal });
        const changes = prepared.filter((operation) => !operation.noOp);

        if (changes.length === 0) {
            return "No file changes were needed; all requested directories already exist.";
        }

        const plan = prepared.map((operation, index) => `${index + 1}. ${operation.plan}`).join("\n");
        // Runnable config is supplied by the host application, never by model
        // arguments. This hook permits isolated approval-policy testing.
        const requestApproval = typeof config?.configurable?.askPermission === "function"
            ? config.configurable.askPermission
            : askPermission;
        const approved = await requestApproval(
            `Approve ${changes.length} file operation${changes.length === 1 ? "" : "s"}`,
            plan,
            { signal: config?.signal }
        );

        if (!approved) {
            return `Cancelled. None of the ${changes.length} planned file operation(s) were executed.`;
        }

        const completed = [];
        async function reportCompletion(operation) {
            const event = {
                type: operation.type,
                path: operation.targetPath ?? operation.sourcePath,
                ...(operation.destinationPath ? { destination: operation.destinationPath } : {}),
                ...(operation.mode ? { mode: operation.mode } : {}),
                status: "complete",
            };
            // Presentation must not turn a committed change into a tool error.
            try { await config?.configurable?.onFileOperation?.(event); }
            catch { /* The confirmed filesystem result remains authoritative. */ }
        }
        for (const operation of changes) {
            try {
                config?.signal?.throwIfAborted();
                if (operation.type === "create_directory") {
                    await resolveWorkspacePath(operation.targetPath, { allowMissing: true });
                    config?.signal?.throwIfAborted();
                    await fs.mkdir(operation.targetPath, { recursive: true });
                    completed.push(`Created directory: ${operation.targetPath}`);
                    await reportCompletion(operation);
                    continue;
                }

                if (operation.type === "write_file") {
                    await resolveWorkspacePath(operation.targetPath, { allowMissing: true });
                    await fs.mkdir(path.dirname(operation.targetPath), { recursive: true });
                    const current = await lstatIfPresent(operation.targetPath);
                    assertNotSymlink(current, operation.targetPath);

                    if (operation.mode === "create") {
                        if (current) throw new Error(`File appeared after approval; refusing to overwrite: ${operation.targetPath}`);
                        config?.signal?.throwIfAborted();
                        await fs.writeFile(operation.targetPath, operation.content, { encoding: "utf8", flag: "wx" });
                    } else {
                        if (!current?.isFile()) throw new Error(`File changed after approval; refusing to replace: ${operation.targetPath}`);
                        await replaceFileAtomically(operation, { signal: config?.signal });
                    }

                    completed.push(`${operation.mode === "replace" ? "Updated" : "Created"} file: ${operation.targetPath}`);
                    await reportCompletion(operation);
                    continue;
                }

                await resolveWorkspacePath(operation.sourcePath);
                await resolveWorkspacePath(operation.destinationPath, { allowMissing: true });
                config?.signal?.throwIfAborted();
                await fs.mkdir(operation.destinationDirectory, { recursive: true });
                const sourceNow = await fs.lstat(operation.sourcePath);
                assertNotSymlink(sourceNow, operation.sourcePath);
                if (!sourceNow.isFile()) throw new Error(`Move source changed after approval: ${operation.sourcePath}`);
                if (sourceNow.dev !== operation.originalIdentity.dev || sourceNow.ino !== operation.originalIdentity.ino ||
                    (await snapshotFile(operation.sourcePath, config?.signal)).digest !== operation.originalDigest) {
                    throw new Error(`Move source changed after the preview: ${operation.sourcePath}`);
                }
                if (await lstatIfPresent(operation.destinationPath)) {
                    throw new Error(`Destination appeared after approval; refusing to overwrite: ${operation.destinationPath}`);
                }

                // Exclusive copy prevents replacement, including across drives; remove source only after copy succeeds.
                config?.signal?.throwIfAborted();
                await fs.copyFile(operation.sourcePath, operation.destinationPath, fsConstants.COPYFILE_EXCL);
                config?.signal?.throwIfAborted();
                const copiedDigest = (await snapshotFile(operation.destinationPath)).digest;
                const sourceDigest = (await snapshotFile(operation.sourcePath)).digest;
                if (copiedDigest !== operation.originalDigest || sourceDigest !== operation.originalDigest) {
                    // Both copies are retained so that concurrent edits are never deleted.
                    throw new Error(`Source changed while moving. Both paths were retained: ${operation.sourcePath} and ${operation.destinationPath}`);
                }
                config?.signal?.throwIfAborted();
                await fs.unlink(operation.sourcePath);
                completed.push(`Moved file: ${operation.sourcePath} -> ${operation.destinationPath}`);
                await reportCompletion(operation);
            } catch (error) {
                const done = completed.length
                    ? `Completed before the error:\n${completed.map((item) => `- ${item}`).join("\n")}`
                    : "No operations completed.";
                return `Batch stopped after an error: ${error.message}\n${done}\nThe remaining operations were not attempted. Verify the listed paths before retrying.`;
            }
        }

        return `Approved batch completed (${completed.length}/${changes.length} operations):\n${completed.map((item) => `- ${item}`).join("\n")}`;
    },
    {
        name: "applyFileOperations",
        description: "Apply a complete batch of file changes with one permission prompt. Include every requested create, explicit replace, directory-create, and move operation in one call. The full plan is shown before anything changes. Never split one requested batch across multiple calls.",
        schema: z.object({
            operations: z.array(fileOperationSchema).min(1).max(25).describe("All file mutations for this user request, in execution order"),
        }),
    }
);

/**
 * List all files and folders inside a specified directory.
 */

export const listDirectoryTool = tool(
    async ({ directory }, config) => {
        const signal = config?.signal;
        signal?.throwIfAborted();
        const safeDirectory = await resolveWorkspacePath(directory);
        const entries = [];
        let truncated = false;
        const handle = await fs.opendir(safeDirectory);
        for await (const entry of handle) {
            signal?.throwIfAborted();
            if (entries.length === MAX_DIRECTORY_RESULTS) { truncated = true; break; }
            entries.push({
                name: entry.name,
                type: entry.isDirectory() ? "folder" : entry.isSymbolicLink() ? "link" : "file",
                path: path.join(safeDirectory, entry.name),
            });
        }
        signal?.throwIfAborted();

        return JSON.stringify(
            {
                entries,
                truncated,
            },
            null,
            2
        );
    },
    {
        name: "listDirectory",
        description:
            `List up to ${MAX_DIRECTORY_RESULTS} files and folders inside a specified directory; the result includes a truncated flag.`,
        schema: z.object({
            directory: z.string().describe("Directory inside the active workspace; relative paths are recommended"),
        }),
    }
);

/** Recursively list bounded workspace entries without following symbolic links. */

export const scanDirectoryTool = tool(
    async ({ directory }, config) => {
        const signal = config?.signal;
        signal?.throwIfAborted();
        const safeDirectory = await resolveWorkspacePath(directory);
        const results = [];
        let truncated = false;

        async function scan(currentPath, depth = 0) {
            signal?.throwIfAborted();
            if (truncated) return;
            if (depth > 5) { truncated = true; return; }

            const handle = await fs.opendir(currentPath);
            for await (const entry of handle) {
                signal?.throwIfAborted();
                if ([
                    "node_modules",
                    ".git",
                    ".next",
                    "dist",
                ].includes(entry.name)) {
                    continue;
                }

                // Never recurse through child symlinks during a workspace scan.
                if (entry.isSymbolicLink()) continue;
                if (results.length >= MAX_DIRECTORY_RESULTS) {
                    truncated = true;
                    return;
                }

                const fullPath = await resolveWorkspacePath(
                    path.join(currentPath, entry.name),
                    { allowMissing: true }
                );

                if (entry.isDirectory()) {
                    results.push({
                        name: entry.name,
                        type: "folder",
                        path: fullPath,
                    });

                    await scan(fullPath, depth + 1);
                } else {
                    const stats = await fs.stat(fullPath);

                    results.push({
                        name: entry.name,
                        type: "file",
                        extension: path.extname(entry.name),
                        size: stats.size,
                        path: fullPath,
                    });
                }
            }
        }

        await scan(safeDirectory);
        signal?.throwIfAborted();

        return JSON.stringify({ results, truncated }, null, 2);
    },
    {
        name: "scanDirectory",
        description:
            `Recursively scan a directory and return up to ${MAX_DIRECTORY_RESULTS} names, extensions, sizes and folders, plus a truncated flag.`,
        schema: z.object({
            directory: z.string().describe("Directory inside the active workspace; relative paths are recommended"),
        }),
    }
);
