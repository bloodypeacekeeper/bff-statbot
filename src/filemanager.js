const fs = require('fs');
const path = require('path');

const FILE_PATH = path.resolve(__dirname, './user-data/saved.json');
const DEFAULT_DATA = { users: [] };

class DataManager {
    /**
     * Ensures the file and directory exist. If not, creates them with default data.
     * @returns {Promise<void>}
     */
    static async ensureFileExists() {
        try {
            // Check if the directory exists; if not, create it
            const dir = path.dirname(FILE_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`Created directory: ${dir}`);
            }

            // Check if the file exists; if not, create it with default data
            if (!fs.existsSync(FILE_PATH)) {
                await fs.promises.writeFile(FILE_PATH, JSON.stringify(DEFAULT_DATA, null, 4), 'utf-8');
                console.log(`Created file: ${FILE_PATH}`);
            }
        } catch (error) {
            console.error(`Error ensuring file exists at ${FILE_PATH}:`, error.message);
            throw error;
        }
    }

    /**
     * Reads the `saved.json` file and parses its content.
     * @returns {Promise<Object>} The parsed JSON content or default data if the file doesn't exist.
     */
    static async readJSON() {
        try {
            await this.ensureFileExists(); // Ensure the file exists before reading
            const data = await fs.promises.readFile(FILE_PATH, 'utf-8');
            const parsed = JSON.parse(data);
            return {
                ...DEFAULT_DATA,
                ...parsed,
                users: Array.isArray(parsed.users) ? parsed.users : []
            };
        } catch (error) {
            console.error(`Error reading file at ${FILE_PATH}:`, error.message);
            throw error;
        }
    }

    /**
     * Saves an object as JSON to the `saved.json` file.
     * @param {Object} data - The data to save as JSON.
     * @returns {Promise<void>}
     */
    static async saveJSON(data) {
        try {
            await this.ensureFileExists(); // Ensure the file exists before saving
            const jsonData = JSON.stringify(data, null, 4); // Pretty-print JSON with 4 spaces
            const tempPath = `${FILE_PATH}.tmp`;
            await fs.promises.writeFile(tempPath, jsonData, 'utf-8');
            await fs.promises.rename(tempPath, FILE_PATH);
        } catch (error) {
            console.error(`Error saving file at ${FILE_PATH}:`, error.message);
            throw error;
        }
    }
}

module.exports = DataManager;
