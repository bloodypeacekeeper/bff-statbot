require('./load-env');

const { REST, Routes, ApplicationCommandOptionType } = require('discord.js');

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID || '1318340064123555903';

if (!token) {
    console.error('DISCORD_BOT_TOKEN is required to register slash commands.');
    process.exit(1);
}

const clanChoices = buildClanChoices();

function buildClanChoices() {
    const indexedChoices = [];

    for (let index = 1; index <= 25; index++) {
        const tag = process.env[`CLAN_${index}_TAG`]?.trim();
        if (tag) indexedChoices.push({ name: tag, value: tag });
    }

    if (indexedChoices.length > 0) return indexedChoices;

    return [
        { name: 'BF-V', value: 'BF-V' },
        { name: 'BF-M', value: 'BF-M' },
        { name: 'BF-C', value: 'BF-C' }
    ];
}

const commands = [
    {
        name: 'register',
        description: 'Register a Discord user to a World of Warships account.',
        options: [
            {
                name: 'discord-user',
                description: 'Discord user being registered.',
                type: ApplicationCommandOptionType.User,
                required: true
            },
            {
                name: 'ign',
                description: 'World of Warships in-game name.',
                type: ApplicationCommandOptionType.String,
                required: true
            },
            {
                name: 'clan',
                description: 'In-game clan assignment.',
                type: ApplicationCommandOptionType.String,
                required: true,
                choices: clanChoices
            },
            {
                name: 'exempt-win-rate',
                description: 'Exempt this user from the win rate requirement. Defaults to false.',
                type: ApplicationCommandOptionType.Boolean,
                required: false
            },
            {
                name: 'exempt-random-battles',
                description: 'Exempt this user from the random battles requirement. Defaults to false.',
                type: ApplicationCommandOptionType.Boolean,
                required: false
            },
            {
                name: 'exempt-tier-10-ships',
                description: 'Exempt this user from the tier 10 ships requirement. Defaults to false.',
                type: ApplicationCommandOptionType.Boolean,
                required: false
            },
            {
                name: 'exempt-attendance',
                description: 'Exempt this user from attendance checks. Defaults to false.',
                type: ApplicationCommandOptionType.Boolean,
                required: false
            }
        ]
    },
    {
        name: 'nonregistered',
        description: 'List in-game clan members who are not registered with the bot.',
        options: [
            {
                name: 'clan',
                description: 'Only list unregistered members from this clan.',
                type: ApplicationCommandOptionType.String,
                required: false,
                choices: clanChoices
            }
        ]
    },
    {
        name: 'roster',
        description: 'List clan rosters with counts, win rate, games, and weighted score.',
        options: [
            {
                name: 'clan',
                description: 'Only list this clan roster.',
                type: ApplicationCommandOptionType.String,
                required: false,
                choices: clanChoices
            }
        ]
    },
    {
        name: 'query',
        description: 'Check a player stats and show clan eligibility.',
        options: [
            {
                name: 'ign',
                description: 'World of Warships in-game name.',
                type: ApplicationCommandOptionType.String,
                required: true
            }
        ]
    },
    {
        name: 'statcheck',
        description: 'Refresh stored stats for registered users.'
    },
    {
        name: 'checkpurge',
        description: 'List registered users who are no longer in configured clans.'
    },
    {
        name: 'remove',
        description: 'Remove a user from the registration list.',
        options: [
            {
                name: 'user',
                description: 'IGN of the registered user to remove.',
                type: ApplicationCommandOptionType.String
            },
            {
                name: 'all',
                description: 'Remove all registered users who are no longer in configured clans.',
                type: ApplicationCommandOptionType.Boolean
            }
        ]
    },
    {
        name: 'testalerts',
        description: 'Send temporary test alert and DM notifications without changing saved data.',
        options: [
            {
                name: 'discord-user',
                description: 'User to receive the test DM. Defaults to you.',
                type: ApplicationCommandOptionType.User,
                required: false
            },
            {
                name: 'alert-channel',
                description: 'Send a test message to the configured alert channel. Defaults to true.',
                type: ApplicationCommandOptionType.Boolean,
                required: false
            },
            {
                name: 'dm',
                description: 'Send a test DM. Defaults to true.',
                type: ApplicationCommandOptionType.Boolean,
                required: false
            }
        ]
    },
    {
        name: 'exemptions',
        description: 'View or adjust registration exemptions for a user.',
        options: [
            {
                name: 'discord-user',
                description: 'Registered Discord user to update.',
                type: ApplicationCommandOptionType.User,
                required: true
            },
            {
                name: 'win-rate',
                description: 'Set win rate exemption.',
                type: ApplicationCommandOptionType.Boolean,
                required: false
            },
            {
                name: 'random-battles',
                description: 'Set random battles exemption.',
                type: ApplicationCommandOptionType.Boolean,
                required: false
            },
            {
                name: 'tier-10-ships',
                description: 'Set tier 10 ships exemption.',
                type: ApplicationCommandOptionType.Boolean,
                required: false
            },
            {
                name: 'attendance',
                description: 'Set permanent attendance exemption.',
                type: ApplicationCommandOptionType.Boolean,
                required: false
            }
        ]
    },
    {
        name: 'loa',
        description: 'Set or clear a leave of absence from attendance checks.',
        options: [
            {
                name: 'discord-user',
                description: 'Registered Discord user to update.',
                type: ApplicationCommandOptionType.User,
                required: true
            },
            {
                name: 'until',
                description: 'LOA end date as YYYY-MM-DD, or clear to remove.',
                type: ApplicationCommandOptionType.String,
                required: true
            }
        ]
    }
];

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
    try {
        console.log('Registering slash commands...');
        await rest.put(Routes.applicationCommands(clientId), { body: commands });
        console.log('Slash commands registered successfully.');
    } catch (error) {
        console.error('Error registering slash commands:', error);
        process.exit(1);
    }
})();
