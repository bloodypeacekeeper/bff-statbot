const fs = require('fs');
const path = require('path');

const ENV_PATH = path.resolve(__dirname, '../.env');

function parseEnvLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return null;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (!key) return null;

    if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
    ) {
        value = value.slice(1, -1);
    }

    return { key, value };
}

function loadEnv() {
    if (!fs.existsSync(ENV_PATH)) return;

    const lines = fs.readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
        const parsed = parseEnvLine(line);
        if (!parsed || process.env[parsed.key] !== undefined) continue;
        process.env[parsed.key] = parsed.value;
    }
}

loadEnv();
