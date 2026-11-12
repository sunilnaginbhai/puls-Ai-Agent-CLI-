import { tool } from "langchain";
import * as z from "zod"
import fs from "fs/promises"
import { constants as fsConstants } from "node:fs";
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

    const root = await fs.realpath(WORKSPACE_ROOT);
    const candidatePath = path.resolve(root, inputPath);

    if (!isWithinWorkspace(root, candidatePath)) {
        throw new Error(`Path is outside the active workspace: ${inputPath}`);
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

async function prepareFileOperations(operations) {
    const prepared = [];
    const plannedTargets = new Set();

    function reserveTarget(targetPath) {
        const key = operationPathKey(targetPath);
        if (plannedTargets.has(key)) {
            throw new Error(`The batch contains more than one operation for: ${targetPath}`);
        }
        plannedTargets.add(key);
    }

    for (const operation of operations) {
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

            reserveTarget(targetPath);
            const preview = operation.content.replace(/\s+/g, " ").slice(0, 120);
            prepared.push({
                ...operation,
                targetPath,
                plan: `${operation.mode === "replace" ? "REPLACE FILE" : "CREATE FILE"}: ${targetPath}\n   ${Buffer.byteLength(operation.content, "utf8")} bytes; parent folders will be created if needed${preview ? `\n   Preview: ${preview}${operation.content.length > 120 ? "…" : ""}` : ""}`,
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
                reserveTarget(targetPath);
                prepared.push({ ...operation, targetPath, plan: `CREATE DIRECTORY: ${targetPath} (including missing parent folders)` });
            }
            continue;
        }

        const sourcePath = await resolveWorkspacePath(operation.source);
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
            plan: `MOVE FILE: ${sourcePath}\n   TO: ${destinationPath}${destinationStats ? "" : "\n   Destination folder will be created if needed"}`,
        });
    }

    return prepared;
}

/** One approval for the complete set of proposed file mutations. */
export const applyFileOperationsTool = tool(
    async ({ operations }) => {
        const prepared = await prepareFileOperations(operations);
        const changes = prepared.filter((operation) => !operation.noOp);

        if (changes.length === 0) {
            return "No file changes were needed; all requested directories already exist.";
        }

        const plan = prepared.map((operation, index) => `${index + 1}. ${operation.plan}`).join("\n");
        const approved = await askPermission(
            `Approve ${changes.length} file operation${changes.length === 1 ? "" : "s"}`,
            plan
        );

        if (!approved) {
            return `Cancelled. None of the ${changes.length} planned file operation(s) were executed.`;
        }

        const completed = [];
        for (const operation of changes) {
            try {
                if (operation.type === "create_directory") {
                    await fs.mkdir(operation.targetPath, { recursive: true });
                    completed.push(`Created directory: ${operation.targetPath}`);
                    continue;
                }

                if (operation.type === "write_file") {
                    await fs.mkdir(path.dirname(operation.targetPath), { recursive: true });
                    const current = await lstatIfPresent(operation.targetPath);
                    assertNotSymlink(current, operation.targetPath);

                    if (operation.mode === "create") {
                        if (current) throw new Error(`File appeared after approval; refusing to overwrite: ${operation.targetPath}`);
                        await fs.writeFile(operation.targetPath, operation.content, { encoding: "utf8", flag: "wx" });
                    } else {
                        if (!current?.isFile()) throw new Error(`File changed after approval; refusing to replace: ${operation.targetPath}`);
                        await fs.writeFile(operation.targetPath, operation.content, { encoding: "utf8" });
                    }

                    completed.push(`${operation.mode === "replace" ? "Updated" : "Created"} file: ${operation.targetPath}`);
                    continue;
                }

                await fs.mkdir(operation.destinationDirectory, { recursive: true });
                const sourceNow = await fs.lstat(operation.sourcePath);
                assertNotSymlink(sourceNow, operation.sourcePath);
                if (!sourceNow.isFile()) throw new Error(`Move source changed after approval: ${operation.sourcePath}`);
                if (await lstatIfPresent(operation.destinationPath)) {
                    throw new Error(`Destination appeared after approval; refusing to overwrite: ${operation.destinationPath}`);
                }

                // Exclusive copy prevents replacement, including across drives; remove source only after copy succeeds.
                await fs.copyFile(operation.sourcePath, operation.destinationPath, fsConstants.COPYFILE_EXCL);
                await fs.unlink(operation.sourcePath);
                completed.push(`Moved file: ${operation.sourcePath} -> ${operation.destinationPath}`);
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
    async ({ directory }) => {
        const safeDirectory = await resolveWorkspacePath(directory);
        const entries = await fs.readdir(safeDirectory, {
            withFileTypes: true,
        });

        return JSON.stringify(
            entries.map((entry) => ({
                name: entry.name,
                type: entry.isDirectory() ? "folder" : "file",
                path: path.join(safeDirectory, entry.name),
            })),
            null,
            2
        );
    },
    {
        name: "listDirectory",
        description:
            "List all files and folders inside a specified directory.",
        schema: z.object({
            directory: z.string().describe("Directory inside the active workspace; relative paths are recommended"),
        }),
    }
);

/**
 * sacndirectoryTool has been removed because it was not used in the graph and was causing confusion. If you need to scan a directory, you can use the listDirectoryTool to list all files and folders inside a specified directory. This will give you the information you need about the contents of the directory.
 */

export const scanDirectoryTool = tool(
    async ({ directory }) => {
        const safeDirectory = await resolveWorkspacePath(directory);
        const results = [];

        async function scan(currentPath, depth = 0) {
            if (depth > 5) return;

            const entries = await fs.readdir(currentPath, {
                withFileTypes: true,
            });

            for (const entry of entries) {
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

        return JSON.stringify(results, null, 2);
    },
    {
        name: "scanDirectory",
        description:
            "Recursively scan a directory and return file names, extensions, sizes and folder information.",
        schema: z.object({
            directory: z.string().describe("Directory inside the active workspace; relative paths are recommended"),
        }),
    }
);
