import { tool } from "langchain";
import * as z from "zod"
import fs from "fs/promises"
import path from "path"
import { askPermission } from "../utils/permissions.utils.js";

/**
 * Create/Update multiple files at once (create one if not existed)
 */
export const upsertFilesTool = tool(
    async function ({ files }) {
        await Promise.all(files.map(async file => {
            return await fs.writeFile(file.path, file.content)
        }))
        return "file created successfully"
    },
    {
        name: "upsertFiles",
        description: "Create/Update multiple files at once (create one if not existed)",
        schema: z.object({
            files: z.array(z.object({
                path: z.string().describe("absolute path of the file to be created/update"),
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
        const entries = await fs.readdir(directory, {
            withFileTypes: true,
        });

        return JSON.stringify(
            entries.map((entry) => ({
                name: entry.name,
                type: entry.isDirectory() ? "folder" : "file",
                path: path.join(directory, entry.name),
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
            directory: z.string(),
        }),
    }
);

/**
 * create directorytool has been removed because it was not used in the graph and was causing confusion. If you need to create a directory, you can use the upsertFilesTool to create a file in that directory, which will automatically create the directory if it does not exist.
 */

export const createDirectoryTool = tool(
    async ({ directory }) => {
        await fs.mkdir(directory, { recursive: true });

        return `Directory created: ${directory}`;
    },
    {
        name: "createDirectory",
        description:
            "Create a new directory or nested directories.",
        schema: z.object({
            directory: z.string(),
        }),
    }
);
/**
 * moveFileTool has been removed because it was not used in the graph and was causing confusion. If you need to move a file, you can use the upsertFilesTool to create a new file at the destination path and then delete the original file using fs.unlink. This will effectively move the file to the new location.
 */


export const moveFileTool = tool(
    async ({ source, destination }) => {

        // 1. Check source file
        const sourceStats = await fs.stat(source);

        if (!sourceStats.isFile()) {
            return "Error: Source must be a file.";
        }

        // 2. Get original filename
        const fileName = path.basename(source);

        if (/^\.[^.]+$/.test(fileName)) {
            return `Refusing to move extension-only hidden file: ${source}`;
        }

        // 3. Build destination path
        const destinationPath = path.join(
            destination,
            fileName
        );

        // 4. Prevent moving a file to itself
        if (path.resolve(source) === path.resolve(destinationPath)) {
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
            `${source}\n\nTO\n\n${destinationPath}`
        );

        if (!approved) {
            return "Operation cancelled by user. No changes were made. Do not retry unless the user asks.";
        }

        // 7. Create destination folder if needed
        await fs.mkdir(destination, {
            recursive: true
        });

        // 8. Move file
        await fs.rename(source, destinationPath);

        return `Successfully moved file:\n${source}\nTO:\n${destinationPath}`;
    },
    {
        name: "moveFile",
        description:
            "Move an existing file from its source path into a destination folder. Preserve the original filename. Ask user permission before moving. Never overwrite existing files.",
        schema: z.object({
            source: z.string().describe("Absolute path of the existing source file"),
            destination: z.string().describe("Absolute path of the destination folder")
        })
    }
);


/**
 * sacndirectoryTool has been removed because it was not used in the graph and was causing confusion. If you need to scan a directory, you can use the listDirectoryTool to list all files and folders inside a specified directory. This will give you the information you need about the contents of the directory.
 */

export const scanDirectoryTool = tool(
    async ({ directory }) => {
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

                const fullPath = path.join(currentPath, entry.name);

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

        await scan(directory);

        return JSON.stringify(results, null, 2);
    },
    {
        name: "scanDirectory",
        description:
            "Recursively scan a directory and return file names, extensions, sizes and folder information.",
        schema: z.object({
            directory: z.string(),
        }),
    }
);

