import { tool } from "langchain";
import * as z from "zod"
import fs from "fs/promises"
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

/**
 * Create/Update multiple files at once (create one if not existed)
 */
export const upsertFilesTool = tool(
    async function ({ files }) {
        // Validate the whole batch before writing any file.
        const validatedFiles = await Promise.all(files.map(async file => ({
            ...file,
            path: await resolveWorkspacePath(file.path, { allowMissing: true }),
        })));

        await Promise.all(validatedFiles.map(async file => {
            return await fs.writeFile(file.path, file.content)
        }))
        return "file created successfully"
    },
    {
        name: "upsertFiles",
        description: "Create/Update multiple files at once (create one if not existed)",
        schema: z.object({
            files: z.array(z.object({
                path: z.string().describe("File path inside the active workspace; relative paths are recommended"),
                content: z.string().describe("content of the file to be created/update")
            }))
        })
    }
)

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
 * create directorytool has been removed because it was not used in the graph and was causing confusion. If you need to create a directory, you can use the upsertFilesTool to create a file in that directory, which will automatically create the directory if it does not exist.
 */

export const createDirectoryTool = tool(
    async ({ directory }) => {
        const safeDirectory = await resolveWorkspacePath(directory, { allowMissing: true });
        await fs.mkdir(safeDirectory, { recursive: true });

        return `Directory created: ${safeDirectory}`;
    },
    {
        name: "createDirectory",
        description:
            "Create a new directory or nested directories.",
        schema: z.object({
            directory: z.string().describe("Directory path inside the active workspace; relative paths are recommended"),
        }),
    }
);
/**
 * moveFileTool has been removed because it was not used in the graph and was causing confusion. If you need to move a file, you can use the upsertFilesTool to create a new file at the destination path and then delete the original file using fs.unlink. This will effectively move the file to the new location.
 */


export const moveFileTool = tool(
    async ({ source, destination }) => {
        const safeSource = await resolveWorkspacePath(source);
        const safeDestination = await resolveWorkspacePath(destination, { allowMissing: true });

        // 1. Check source file
        const sourceStats = await fs.stat(safeSource);

        if (!sourceStats.isFile()) {
            return "Error: Source must be a file.";
        }

        // 2. Get original filename
        const fileName = path.basename(source);

        if (/^\.[^.]+$/.test(fileName)) {
            return `Refusing to move extension-only hidden file: ${source}`;
        }

        // 3. Build destination path
        const destinationPath = await resolveWorkspacePath(path.join(
            safeDestination,
            fileName
        ), { allowMissing: true });

        // 4. Prevent moving a file to itself
        if (path.resolve(safeSource) === path.resolve(destinationPath)) {
            return "Error: Source and destination are the same.";
        }

        // 5. Prevent overwriting
        try {
            await fs.access(destinationPath);

            return `Error: File already exists at ${destinationPath}`;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }

        // 6. Ask user permission
        const approved = await askPermission(
            "Move File",
            `${safeSource}\n\nTO\n\n${destinationPath}`
        );

        if (!approved) {
            return "Operation cancelled by user. No changes were made. Do not retry unless the user asks.";
        }

        // 7. Create destination folder if needed
        await fs.mkdir(safeDestination, {
            recursive: true
        });

        // 8. Move file
        await fs.rename(safeSource, destinationPath);

        return `Successfully moved file:\n${safeSource}\nTO:\n${destinationPath}`;
    },
    {
        name: "moveFile",
        description:
            "Move an existing file from its source path into a destination folder. Preserve the original filename. Ask user permission before moving. Never overwrite existing files.",
        schema: z.object({
            source: z.string().describe("Existing file path inside the active workspace; relative paths are recommended"),
            destination: z.string().describe("Destination folder inside the active workspace; relative paths are recommended")
        })
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

