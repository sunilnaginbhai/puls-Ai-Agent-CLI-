import fs from 'fs/promises'
import { CONFIG_DIR } from './constant.js'
import path from 'path'
import axios from 'axios'


/**
 * Return the content of the settings file (create if it doesn't exist)
 */

export async function getSettingsFile() {
    try {
        await fs.access(CONFIG_DIR);
    } catch (error) {
        // Handle the case where the directory doesn't exist than create it
        await fs.mkdir(CONFIG_DIR, { recursive: true }); //recursive mining ensures that all directories in the path are created if they don't exist
    }

    const settingsFilePath = path.join(CONFIG_DIR, 'settings.json');

    try {
        await fs.access(settingsFilePath);
        const content = await fs.readFile(settingsFilePath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        // Handle the case where the file doesn't exist than create it
        await fs.writeFile(settingsFilePath, JSON.stringify({})); //why write an empty object? Because we want to create a settings file with an empty object as its initial content. This allows us to have a valid JSON structure in the file, which can be easily updated later with actual settings.
        return {};
    }
}

/**
 * Save API key to the settings file
 */

export async function saveApiKey(apiKey) {

    const settingsFilePath = path.join(CONFIG_DIR, 'settings.json');

    const settingsContent = await getSettingsFile();
    await fs.writeFile(settingsFilePath, JSON.stringify({
        ...settingsContent,
        apiKey
    }));
}

/**
 * get api key from the settings file
 */

export async function getApiKey() {
    const settingsContent = await getSettingsFile();


    const apiKey = settingsContent.apiKey;

    if (!apiKey) {
        return {
            error: "API key not found. Please set your API key using the 'set-api-key' command."
        }
    }

    try {
        const response = await axios.get('https://api.groq.com/openai/v1/models', {
            headers: {
                'Authorization': `Bearer ${apiKey}`
            }
        });

        return {
            apiKey
        }
    } catch (error) {
        return {
            error: "Invalid API key. Please set a valid API key using the 'set-api-key' command."
        }
    }
}