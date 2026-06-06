require('./load-env');

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Client,
    Events,
    GatewayIntentBits,
    ActivityType,
    MessageFlags,
    PermissionsBitField
} = require('discord.js');
const axios = require('axios');
const cron = require('node-cron');
const DataManager = require('./filemanager');

const CONFIG = {
    discordToken: process.env.DISCORD_BOT_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID || '1318340064123555903',
    alertChannelId: process.env.ALERT_CHANNEL_ID,
    guildId: process.env.DISCORD_GUILD_ID,
    recruiterRoleId: process.env.RECRUITER_ROLE_ID || '1296575103152160808',
    fleetRoleId: process.env.FLEET_ROLE_ID || '',
    rolesToRemoveOnRegister: parseIdList(process.env.ROLES_TO_REMOVE_ON_REGISTER),
    rolesToAddOnUnregister: parseIdList(process.env.ROLES_TO_ADD_ON_UNREGISTER),
    recruiterBypassUserIds: (process.env.RECRUITER_BYPASS_USER_IDS || '680892416672530623')
        .split(',')
        .map(userId => userId.trim())
        .filter(Boolean),
    wargamingApplicationId: process.env.WARGAMING_APPLICATION_ID || '6b0454e966a9b12d03867db075338f8a',
    dailyCheckTimezone: process.env.DAILY_CHECK_TIMEZONE || 'America/Chicago',
    messages: buildMessages()
};

const CLANS = buildConfiguredClans();

const CLAN_REQUIREMENTS = Object.fromEntries(
    Object.values(CLANS).map(clan => [clan.label, buildClanRequirements(clan.envPrefix)])
);

const DAY_MS = 24 * 60 * 60 * 1000;
const WG_API_BASE = 'https://api.worldofwarships.com/wows';

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

client.once(Events.ClientReady, () => {
    console.log(`Bot has started as ${client.user.tag}.`);
    client.user.setPresence({
        activities: [{ name: 'Watching BF stats', type: ActivityType.Watching }],
        status: 'dnd'
    });

    cron.schedule('0 12 * * *', runDailyChecks, {
        timezone: CONFIG.dailyCheckTimezone
    });
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton()) {
        return handleButtonInteraction(interaction);
    }

    if (!interaction.isChatInputCommand()) return;

    if (!memberHasRecruiterRole(interaction)) {
        return interaction.reply({
            content: CONFIG.messages.noPermission,
            flags: MessageFlags.Ephemeral
        });
    }

    try {
        switch (interaction.commandName) {
            case 'register':
                await handleRegister(interaction);
                break;
            case 'nonregistered':
                await handleNonRegistered(interaction);
                break;
            case 'statcheck':
                await handleStatCheck(interaction);
                break;
            case 'checkpurge':
                await handleCheckPurge(interaction);
                break;
            case 'remove':
                await handleRemove(interaction);
                break;
            case 'testalerts':
                await handleTestAlerts(interaction);
                break;
            case 'exemptions':
                await handleExemptions(interaction);
                break;
            case 'loa':
                await handleLoa(interaction);
                break;
            case 'roster':
                await handleRoster(interaction);
                break;
            case 'query':
                await handleQuery(interaction);
                break;
        }
    } catch (error) {
        console.error(`Command ${interaction.commandName} failed:`, error);
        await replyOrEdit(interaction, `Error: ${error.message}`);
    }
});

async function handleButtonInteraction(interaction) {
    if (!interaction.customId.startsWith('unregister-user:')) return;

    if (!memberHasRecruiterRole(interaction)) {
        return interaction.reply({
            content: CONFIG.messages.noPermissionAction,
            flags: MessageFlags.Ephemeral
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const accountId = interaction.customId.split(':')[1];
        const guild = interaction.guild || await getGuildForDailyChecks();
        const result = await unregisterUserByAccountId(accountId, guild);

        if (!result.removedUser) {
            return interaction.editReply('That user is no longer registered.');
        }

        await disableButtonMessage(interaction, `Unregistered ${result.removedUser.ign}`);
        await interaction.editReply(formatUnregisterResult(result));
    } catch (error) {
        console.error('Unregister button failed:', error);
        await interaction.editReply(`Error: ${error.message}`);
    }
}

function memberHasRecruiterRole(interaction) {
    return CONFIG.recruiterBypassUserIds.includes(interaction.user.id)
        || Boolean(interaction.member?.roles?.cache?.has(CONFIG.recruiterRoleId));
}

async function handleRegister(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const discordUser = interaction.options.getUser('discord-user', true);
    const ign = interaction.options.getString('ign', true).trim();
    const clanTag = interaction.options.getString('clan', true);
    const exemptions = getRegistrationExemptionsFromInteraction(interaction);
    const clan = getClan(clanTag);

    ensureClanCanManageDiscordRole(clan);

    const account = await WargamingApi.findExactAccount(ign);
    if (!account) {
        return interaction.editReply(formatMessage(CONFIG.messages.registerNotFound, { ign }));
    }

    const stats = await WargamingApi.getAccountStats(account.account_id);
    if (!stats) {
        return interaction.editReply(formatMessage(CONFIG.messages.registerNoStats, { ign: account.nickname }));
    }
    stats.clanBattles = await WargamingApi.getClanBattleStats(account.account_id);
    stats.activityBattles = getActivityBattles(stats);

    const requirementResult = await evaluateRequirements(account.account_id, stats, clanTag, exemptions);
    if (!requirementResult.passed) {
        return interaction.editReply([
            formatMessage(CONFIG.messages.requirementsFailed, { ign: account.nickname }),
            ...requirementResult.failures.map(failure => `- ${failure}`)
        ].join('\n'));
    }

    const guildMember = await interaction.guild.members.fetch(discordUser.id);
    const identityResult = await applyClanIdentity(guildMember, clan, account.nickname);

    const data = await DataManager.readJSON();
    const userRecord = buildUserRecord({
        account,
        discordUser,
        clanTag,
        clan,
        exemptions,
        stats
    });
    upsertUser(data, userRecord);
    await DataManager.saveJSON(data);

    const nicknameNote = identityResult.nicknameUpdated
        ? ''
        : `\nNote: I could not change this member's nickname. Set it manually to **[${clanTag}] ${account.nickname}**.`;

    await interaction.editReply(`${formatMessage(CONFIG.messages.registerSuccess, {
        user: `<@${discordUser.id}>`,
        clan: clanTag,
        ign: account.nickname
    })}${nicknameNote}`);
}

async function handleNonRegistered(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const clanTag = interaction.options.getString('clan');
    const data = await DataManager.readJSON();
    const registeredIds = new Set(data.users.map(user => String(user.id)));
    const clanMembers = await WargamingApi.getConfiguredClanMembers(clanTag);
    const missing = clanMembers.filter(member => !registeredIds.has(String(member.accountId)));

    if (missing.length === 0) {
        const scope = clanTag ? `${clanTag} clan members` : 'configured clan members';
        return interaction.editReply(`All ${scope} are registered.`);
    }

    const lines = missing.map(member => `- **[${member.clanTag}] ${member.nickname || member.accountId}**`);
    const title = clanTag
        ? `${clanTag} clan members not registered with the bot:`
        : 'Clan members not registered with the bot:';
    await sendChunkedInteractionReply(interaction, title, lines);
}

async function handleRoster(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const clanTag = interaction.options.getString('clan');
    const clanMembers = await WargamingApi.getConfiguredClanMembers(clanTag);
    if (clanMembers.length === 0) {
        return interaction.editReply(clanTag ? `No members found for ${clanTag}.` : 'No configured clan members found.');
    }

    const statsById = await WargamingApi.getAccountStatsBatch(clanMembers.map(member => member.accountId));
    const rows = clanMembers.map(member => {
        const stats = statsById.get(String(member.accountId));
        const randomBattles = stats?.randomBattles || 0;
        const winRate = stats?.winRate || 0;
        return {
            ...member,
            nickname: stats?.nickname || member.nickname || member.accountId,
            randomBattles,
            winRate,
            score: winRate + (randomBattles / 250)
        };
    }).sort((left, right) => right.score - left.score);

    const counts = Object.values(CLANS)
        .filter(clan => !clanTag || clan.label === clanTag)
        .map(clan => `${clan.label}: ${rows.filter(row => row.clanTag === clan.label).length}`)
        .join(' | ');
    const lines = rows.map(row =>
        `- **[${row.clanTag}] ${row.nickname}** - ${row.winRate.toFixed(2)}% WR, ${row.randomBattles} games, score ${row.score.toFixed(2)}`
    );

    await sendChunkedInteractionReply(interaction, `Roster (${counts})`, lines);
}

async function handleQuery(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const ign = interaction.options.getString('ign', true).trim();
    const account = await WargamingApi.findExactAccount(ign);
    if (!account) {
        return interaction.editReply(formatMessage(CONFIG.messages.registerNotFound, { ign }));
    }

    const stats = await WargamingApi.getAccountStats(account.account_id);
    if (!stats) {
        return interaction.editReply(formatMessage(CONFIG.messages.registerNoStats, { ign: account.nickname }));
    }

    stats.clanBattles = await WargamingApi.getClanBattleStats(account.account_id);
    stats.activityBattles = getActivityBattles(stats);

    const needsTier10 = Object.values(CLAN_REQUIREMENTS).some(requirements => requirements.minimumTier10ShipsPlayed !== null);
    const tier10ShipsPlayed = needsTier10 ? await WargamingApi.countTier10ShipsPlayed(account.account_id) : null;
    const eligibilityLines = [];

    for (const clan of Object.values(CLANS)) {
        const result = evaluateRequirementSnapshot(stats, CLAN_REQUIREMENTS[clan.label] || {}, { tier10ShipsPlayed });
        eligibilityLines.push(result.passed
            ? `- **${clan.label}**: eligible`
            : `- **${clan.label}**: not eligible (${result.failures.join('; ')})`);
    }

    await interaction.editReply([
        `Stats for **${account.nickname}**:`,
        `- Account ID: ${account.account_id}`,
        `- Win rate: ${stats.winRate.toFixed(2)}%`,
        `- Random battles: ${stats.randomBattles}`,
        `- Clan battles: ${stats.clanBattles || 0}`,
        `- Activity battles: ${getActivityBattles(stats)}`,
        `- Tier 10 ships played: ${tier10ShipsPlayed ?? 'not checked'}`,
        '',
        'Clan eligibility:',
        ...eligibilityLines
    ].join('\n'));
}

async function handleStatCheck(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const data = await refreshStoredStats();
    await DataManager.saveJSON(data);
    await interaction.editReply(`Updated stats for ${data.users.length} registered users.`);
}

async function handleCheckPurge(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const data = await DataManager.readJSON();
    const clanMembers = await WargamingApi.getConfiguredClanMembers();
    const memberIds = new Set(clanMembers.map(member => String(member.accountId)));
    const usersOutsideConfiguredClans = data.users.filter(user => !memberIds.has(String(user.id)));

    if (usersOutsideConfiguredClans.length === 0) {
        return interaction.editReply('All registered users are still in configured clans.');
    }

    const lines = usersOutsideConfiguredClans.map(user => `- **${user.ign}** (<@${user.discordid}>)`);
    await sendChunkedInteractionReply(interaction, 'Registered users not found in configured clans:', lines);
}

async function handleRemove(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const data = await DataManager.readJSON();
    const ign = interaction.options.getString('user');
    const removeAllOutsideClans = interaction.options.getBoolean('all') ?? false;

    if (removeAllOutsideClans) {
        const clanMembers = await WargamingApi.getConfiguredClanMembers();
        const memberIds = new Set(clanMembers.map(member => String(member.accountId)));
        const usersToRemove = data.users.filter(user => !memberIds.has(String(user.id)));
        const results = [];

        for (const user of usersToRemove) {
            results.push(await unregisterUserByAccountId(user.id, interaction.guild));
        }

        const removed = results.filter(result => result.removedUser);
        if (removed.length === 0) {
            return interaction.editReply('No users were removed.');
        }

        const lines = removed.map(result => `- **${result.removedUser.ign}** (<@${result.removedUser.discordid}>)${result.roleNote ? ` (${result.roleNote})` : ''}`);
        return sendChunkedInteractionReply(interaction, 'Removed users no longer found in configured clans:', lines);
    }

    if (!ign) {
        return interaction.editReply('Provide an IGN or set `all` to true.');
    }

    const userIndex = data.users.findIndex(user => user.ign.toLowerCase() === ign.toLowerCase());
    if (userIndex === -1) {
        return interaction.editReply(`No registered user was found for **${ign}**.`);
    }

    const result = await unregisterUserByAccountId(data.users[userIndex].id, interaction.guild);
    await interaction.editReply(formatUnregisterResult(result));
}

async function handleExemptions(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const discordUser = interaction.options.getUser('discord-user', true);
    const data = await DataManager.readJSON();
    const user = data.users.find(savedUser => String(savedUser.discordid) === String(discordUser.id));

    if (!user) {
        return interaction.editReply(`<@${discordUser.id}> is not registered.`);
    }

    const current = normalizeExemptions(user);
    const updates = getExemptionUpdatesFromInteraction(interaction);

    if (Object.keys(updates).length === 0) {
        return interaction.editReply(formatExemptionsMessage(user, current, 'Current exemptions'));
    }

    user.exemptions = {
        ...current,
        ...updates
    };
    await DataManager.saveJSON(data);

    await interaction.editReply(formatExemptionsMessage(user, user.exemptions, 'Updated exemptions'));
}

async function handleLoa(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const discordUser = interaction.options.getUser('discord-user', true);
    const untilInput = interaction.options.getString('until', true).trim();
    const data = await DataManager.readJSON();
    const user = data.users.find(savedUser => String(savedUser.discordid) === String(discordUser.id));

    if (!user) {
        return interaction.editReply(`<@${discordUser.id}> is not registered.`);
    }

    user.exemptions = normalizeExemptions(user);

    if (untilInput.toLowerCase() === 'clear') {
        user.exemptions.loaUntil = null;
        await DataManager.saveJSON(data);
        return interaction.editReply(`Cleared LOA for **${user.ign}**.`);
    }

    const loaUntil = parseLoaDate(untilInput);
    if (!loaUntil) {
        return interaction.editReply('Invalid LOA date. Use `YYYY-MM-DD`, or `clear` to remove an LOA.');
    }

    user.exemptions.loaUntil = loaUntil;
    await DataManager.saveJSON(data);

    await interaction.editReply(`Set LOA for **${user.ign}** through **${untilInput}**. Attendance checks are exempt until then.`);
}

async function handleTestAlerts(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetUser = interaction.options.getUser('discord-user') || interaction.user;
    const sendAlert = interaction.options.getBoolean('alert-channel') ?? true;
    const sendDm = interaction.options.getBoolean('dm') ?? true;
    const requesterSummary = await getRegisteredRequesterTestSummary(interaction.user.id);
    const testDetails = [
        `TEST ONLY: alert/DM delivery requested by <@${interaction.user.id}> for <@${targetUser.id}>.`,
        'No registration data was changed.',
        requesterSummary
    ].filter(Boolean).join('\n');
    const results = [];

    if (!sendAlert && !sendDm) {
        return interaction.editReply('Nothing to test. Enable `alert-channel`, `dm`, or both.');
    }

    if (sendAlert) {
        await sendAlertMessages([testDetails]);
        results.push('alert channel message sent');
    }

    if (sendDm) {
        await dmUser(targetUser.id, testDetails);
        results.push(`DM attempted for <@${targetUser.id}>`);
    }

    const requesterNote = requesterSummary
        ? '\nRequester registration data was included in the test payload.'
        : '\nRequester is not registered, so no player data was included.';
    await interaction.editReply(`Test complete: ${results.join(', ')}.${requesterNote}`);
}

async function runDailyChecks() {
    try {
        console.log('Running daily registration checks...');
        const data = await refreshStoredStats();
        const guild = await getGuildForDailyChecks();
        const clanMembers = await WargamingApi.getConfiguredClanMembers();
        const clanMemberLookup = new Map(clanMembers.map(member => [String(member.accountId), member]));
        const now = Date.now();

        for (const user of data.users) {
            const stats = user.stats || statsFromLegacyUser(user);
            const clanRequirements = CLAN_REQUIREMENTS[user.clanTag] || {};
            const attendanceDays = Number(clanRequirements.attendanceDays || 0);
            const alertChannel = await client.channels.fetch(clanRequirements.alertChannel);

            const activity = updateActivityWindow(
                user,
                stats,
                now,
                attendanceDays
            );

            const exemptions = normalizeExemptions(user);

            if (
                attendanceDays > 0
                && activity.inactive
                && !isAttendanceExempt(exemptions, now)
            ) {
                await alertChannel.send(formatMessage(CONFIG.messages.attendanceAlert, {
                    ign: user.ign,
                    user: `<@${user.discordid}>`,
                    days: attendanceDays
                }));

                await dmUser(
                    user.discordid,
                    formatMessage(CONFIG.messages.attendanceDm, {
                        ign: user.ign,
                        user: `<@${user.discordid}>`,
                        days: attendanceDays
                    })
                );
            }

            const member = await fetchGuildMember(guild, user.discordid);
            if (!member) {
                await alertChannel.send(`Discord: **${user.ign}** (${user.discordid}) is registered but is no longer in the Discord.`);
            } else {
                const nicknameUpdated = await syncRegisteredNickname(member, user);
                if (nicknameUpdated) {
                    await alertChannel.send(`Nickname: updated <@${user.discordid}> to **[${user.clanTag}] ${user.ign}**.`);
                }
            }

            const clanMember = clanMemberLookup.get(String(user.id));
            if (!clanMember) {
                if (member) {
                    await sendUnregisterActionAlert(
                        user,
                        `Clan: **${user.ign}** (<@${user.discordid}>) is registered but is not in a configured in-game clan.`,
                        clanRequirements.alertChannel
                    );
                } else {
                    await alertChannel.send(`Clan: **${user.ign}** (${user.discordid}) is registered but is not in a configured in-game clan.`);
                }
            } else if (user.clanTag && clanMember.clanTag !== user.clanTag) {
                if (member) {
                    await sendUnregisterActionAlert(
                        user,
                        `Clan: **${user.ign}** (<@${user.discordid}>) is registered as **${user.clanTag}** but is currently in **${clanMember.clanTag}**.`,
                        clanRequirements.alertChannel
                    );
                } else {
                    await alertChannel.send(`Clan: **${user.ign}** (${user.discordid}) is registered as **${user.clanTag}** but is currently in **${clanMember.clanTag}**.`);
                }
            }
        }

        await DataManager.saveJSON(data);
        console.log(`Daily checks completed.`);
    } catch (error) {
        console.error('Daily checks failed:', error);
    }
}

async function evaluateRequirements(accountId, stats, clanTag, exemptions = createDefaultExemptions()) {
    const requirements = CLAN_REQUIREMENTS[clanTag] || {};
    if (!hasEnabledRequirements(requirements)) {
        return { passed: true, failures: [] };
    }

    const activeExemptions = normalizeExemptions({ exemptions });
    const tier10ShipsPlayed = requirements.minimumTier10ShipsPlayed === null || activeExemptions.tier10Ships
        ? null
        : await WargamingApi.countTier10ShipsPlayed(accountId);
    return evaluateRequirementSnapshot(stats, requirements, {
        tier10ShipsPlayed,
        exemptions: activeExemptions
    });
}

function evaluateRequirementSnapshot(stats, requirements, options = {}) {
    const exemptions = options.exemptions || createDefaultExemptions();
    const tier10ShipsPlayed = options.tier10ShipsPlayed;
    const failures = [];

    if (!exemptions.winRate && requirements.minimumWinRate !== null && stats.winRate < requirements.minimumWinRate) {
        failures.push(`WR ${stats.winRate.toFixed(2)}% < ${requirements.minimumWinRate}%`);
    }

    if (!exemptions.randomBattles && requirements.minimumRandomBattles !== null && stats.randomBattles < requirements.minimumRandomBattles) {
        failures.push(`games ${stats.randomBattles} < ${requirements.minimumRandomBattles}`);
    }

    if (!exemptions.tier10Ships && requirements.minimumTier10ShipsPlayed !== null && tier10ShipsPlayed < requirements.minimumTier10ShipsPlayed) {
        failures.push(`tier 10 ships ${tier10ShipsPlayed} < ${requirements.minimumTier10ShipsPlayed}`);
    }

    return { passed: failures.length === 0, failures };
}

function buildClanRequirements(envPrefix) {
    return {
        minimumWinRate: getOptionalNumber(`${envPrefix}_MIN_WIN_RATE`),
        minimumRandomBattles: getOptionalNumber(`${envPrefix}_MIN_RANDOM_BATTLES`),
        minimumTier10ShipsPlayed: getOptionalNumber(`${envPrefix}_MIN_TIER_10_SHIPS_PLAYED`),
        attendanceDays: getAttendanceDays(`${envPrefix}_ATTENDANCE_DAYS`),
        alertChannel: getOptionalString(`${envPrefix}_ALERT_CHANNEL`)
    };
}

function parseIdList(value) {
    if (!value || value.trim() === '') return [];

    return [...new Set(value
        .split(',')
        .map(id => id.trim())
        .filter(Boolean))];
}

function buildMessages() {
    return {
        noPermission: process.env.MSG_NO_PERMISSION || 'You do not have the required role to use this command.',
        noPermissionAction: process.env.MSG_NO_PERMISSION_ACTION || 'You do not have the required role to use this action.',
        userNotRegistered: process.env.MSG_USER_NOT_REGISTERED || '{user} is not registered.',
        registerNotFound: process.env.MSG_REGISTER_NOT_FOUND || 'No World of Warships account was found for **{ign}**.',
        registerNoStats: process.env.MSG_REGISTER_NO_STATS || 'Wargaming returned no stat data for **{ign}**.',
        registerSuccess: process.env.MSG_REGISTER_SUCCESS || 'Registered {user} as **[{clan}] {ign}**.',
        requirementsFailed: process.env.MSG_REQUIREMENTS_FAILED || '**{ign}** was not registered because these requirements were not met:',
        attendanceAlert: process.env.MSG_ATTENDANCE_ALERT || 'Activity: **{ign}** ({user}) has not recorded a random or clan battle in {days} days.',
        attendanceDm: process.env.MSG_ATTENDANCE_DM || 'Activity check: please play at least one random or clan battle within {days} days to remain compliant with clan requirements.',
        dailyAlertHeader: process.env.MSG_DAILY_ALERT_HEADER || 'Daily check alerts:',
        unregisterButton: process.env.MSG_UNREGISTER_BUTTON || 'Unregister User'
    };
}

function buildConfiguredClans() {
    const indexedClans = [];

    for (let index = 1; index <= 25; index++) {
        const envPrefix = `CLAN_${index}`;
        const label = process.env[`${envPrefix}_TAG`]?.trim();
        if (!label) continue;

        indexedClans.push({
            label,
            clanId: process.env[`${envPrefix}_ID`]?.trim() || '',
            roleId: process.env[`${envPrefix}_ROLE_ID`]?.trim() || '',
            envPrefix
        });
    }

    return Object.fromEntries(indexedClans.map(clan => [clan.label, clan]));
}

function formatMessage(template, values = {}) {
    return template.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
}

function getOptionalNumber(envName) {
    const rawValue = process.env[envName];
    if (rawValue === undefined || rawValue.trim() === '') return null;

    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
        throw new Error(`${envName} must be a number when provided.`);
    }

    return value === 0 ? null : value;
}

function getOptionalString(envName) {
    const value = process.env[envName];
    return value?.trim() || null;
}

function getAttendanceDays(envName) {
    const rawValue = process.env[envName];

    if (rawValue === undefined || rawValue.trim() === '') {
        return 0;
    }

    const value = Number(rawValue);

    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${envName} must be a positive number or 0.`);
    }

    return value;
}

function hasEnabledRequirements(requirements) {
    return [
        requirements.minimumWinRate,
        requirements.minimumRandomBattles,
        requirements.minimumTier10ShipsPlayed
    ].some(value => value !== null);
}

function createDefaultExemptions() {
    return {
        winRate: false,
        randomBattles: false,
        tier10Ships: false,
        attendance: false,
        loaUntil: null
    };
}

function normalizeExemptions(user) {
    const defaults = createDefaultExemptions();
    const legacyAllRegistrationExempt = user.exemptRequirements === true;

    return {
        ...defaults,
        winRate: Boolean(user.exemptions?.winRate ?? legacyAllRegistrationExempt),
        randomBattles: Boolean(user.exemptions?.randomBattles ?? legacyAllRegistrationExempt),
        tier10Ships: Boolean(user.exemptions?.tier10Ships ?? legacyAllRegistrationExempt),
        attendance: Boolean(user.exemptions?.attendance ?? false),
        loaUntil: user.exemptions?.loaUntil || null
    };
}

function getRegistrationExemptionsFromInteraction(interaction) {
    return {
        ...createDefaultExemptions(),
        winRate: interaction.options.getBoolean('exempt-win-rate') ?? interaction.options.getBoolean('exempt-requirements') ?? false,
        randomBattles: interaction.options.getBoolean('exempt-random-battles') ?? interaction.options.getBoolean('exempt-requirements') ?? false,
        tier10Ships: interaction.options.getBoolean('exempt-tier-10-ships') ?? interaction.options.getBoolean('exempt-requirements') ?? false,
        attendance: interaction.options.getBoolean('exempt-attendance') ?? false
    };
}

function getExemptionUpdatesFromInteraction(interaction) {
    const optionMap = {
        'win-rate': 'winRate',
        'random-battles': 'randomBattles',
        'tier-10-ships': 'tier10Ships',
        attendance: 'attendance'
    };
    const updates = {};

    for (const [optionName, exemptionName] of Object.entries(optionMap)) {
        const value = interaction.options.getBoolean(optionName);
        if (value !== null) {
            updates[exemptionName] = value;
        }
    }

    return updates;
}

function isAttendanceExempt(exemptions, now = Date.now()) {
    if (exemptions.attendance) return true;
    if (!exemptions.loaUntil) return false;

    const loaUntil = Date.parse(exemptions.loaUntil);
    return Number.isFinite(loaUntil) && now <= loaUntil;
}

function parseLoaDate(input) {
    const match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;

    const [, year, month, day] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999));
    if (
        date.getUTCFullYear() !== Number(year)
        || date.getUTCMonth() !== Number(month) - 1
        || date.getUTCDate() !== Number(day)
    ) {
        return null;
    }

    return date.toISOString();
}

function formatExemptionsMessage(user, exemptions, title) {
    const loaStatus = exemptions.loaUntil
        ? `${formatDateTime(exemptions.loaUntil)} (${Date.now() <= Date.parse(exemptions.loaUntil) ? 'active' : 'expired'})`
        : 'none';

    return [
        `${title} for **${user.ign}**:`,
        `- Win rate: ${formatBoolean(exemptions.winRate)}`,
        `- Random battles: ${formatBoolean(exemptions.randomBattles)}`,
        `- Tier 10 ships: ${formatBoolean(exemptions.tier10Ships)}`,
        `- Attendance: ${formatBoolean(exemptions.attendance)}`,
        `- LOA until: ${loaStatus}`
    ].join('\n');
}

function formatBoolean(value) {
    return value ? 'exempt' : 'not exempt';
}

async function refreshStoredStats() {
    const data = await DataManager.readJSON();
    const accountIds = data.users.map(user => String(user.id)).filter(Boolean);
    const statsById = await WargamingApi.getAccountStatsBatch(accountIds);
    const clanBattlesById = await WargamingApi.getClanBattleStatsBatch(accountIds);

    for (const user of data.users) {
        const stats = statsById.get(String(user.id));
        if (!stats) continue;

        const clanBattles = clanBattlesById.get(String(user.id)) || 0;
        stats.clanBattles = clanBattles;
        stats.activityBattles = getActivityBattles(stats);
        user.ign = stats.nickname || user.ign;
        user.gamesplayed = stats.randomBattles;
        user.clanBattles = stats.clanBattles;
        user.winrate = stats.winRate.toFixed(2);
        user.stats = {
            randomBattles: stats.randomBattles,
            clanBattles: stats.clanBattles,
            activityBattles: stats.activityBattles,
            wins: stats.wins,
            losses: stats.losses,
            draws: stats.draws,
            winRate: Number(stats.winRate.toFixed(2)),
            lastBattleTime: stats.lastBattleTime
        };
    }

    return data;
}

function buildUserRecord({ account, discordUser, clanTag, clan, exemptions, stats }) {
    const activityBattles = getActivityBattles(stats);

    return {
        id: String(account.account_id),
        discordid: discordUser.id,
        ign: account.nickname,
        clanTag,
        clanId: clan.clanId,
        exemptions: normalizeExemptions({ exemptions }),
        exemptRequirements: false,
        registeredAt: new Date().toISOString(),
        gamesplayed: stats.randomBattles,
        clanBattles: stats.clanBattles || 0,
        winrate: stats.winRate.toFixed(2),
        stats: {
            randomBattles: stats.randomBattles,
            clanBattles: stats.clanBattles || 0,
            activityBattles,
            wins: stats.wins,
            losses: stats.losses,
            draws: stats.draws,
            winRate: Number(stats.winRate.toFixed(2)),
            lastBattleTime: stats.lastBattleTime
        },
        activity: {
            lastBattleIncreaseAt: new Date().toISOString(),
            lastKnownRandomBattles: stats.randomBattles,
            lastKnownActivityBattles: activityBattles,
            lastActivityAlertAt: null
        }
    };
}

function upsertUser(data, userRecord) {
    if (!Array.isArray(data.users)) data.users = [];

    const existingIndex = data.users.findIndex(user =>
        String(user.id) === userRecord.id || String(user.discordid) === userRecord.discordid
    );

    if (existingIndex === -1) {
        data.users.push(userRecord);
        return;
    }

    data.users[existingIndex] = {
        ...data.users[existingIndex],
        ...userRecord,
        registeredAt: data.users[existingIndex].registeredAt || userRecord.registeredAt
    };
}

function updateActivityWindow(user, stats, now, attendanceDays = 30) {
    const currentActivityBattles = getActivityBattles(stats);
    const hasActivityBattleBaseline = user.activity?.lastKnownActivityBattles !== undefined;
    const previousActivityBattles = user.activity?.lastKnownActivityBattles ?? currentActivityBattles;
    const previousRandomBattles = user.activity?.lastKnownRandomBattles ?? 0;
    const lastBattleAt = stats.lastBattleTime ? new Date(Number(stats.lastBattleTime) * 1000).toISOString() : new Date(now).toISOString();

    if (!user.activity) {
        user.activity = {
            lastBattleIncreaseAt: lastBattleAt,
            lastKnownRandomBattles: stats.randomBattles,
            lastKnownActivityBattles: currentActivityBattles,
            lastActivityAlertAt: null
        };
    }

    const hasNewActivity = hasActivityBattleBaseline
        ? currentActivityBattles > previousActivityBattles
        : stats.randomBattles > previousRandomBattles;

    if (hasNewActivity) {
        user.activity.lastBattleIncreaseAt = new Date(now).toISOString();
        user.activity.lastKnownRandomBattles = stats.randomBattles;
        user.activity.lastKnownActivityBattles = currentActivityBattles;
        user.activity.lastActivityAlertAt = null;
        return { inactive: false };
    }

    user.activity.lastKnownRandomBattles = stats.randomBattles;
    user.activity.lastKnownActivityBattles = currentActivityBattles;
    const lastIncrease = Date.parse(user.activity.lastBattleIncreaseAt);
    const lastAlert = user.activity.lastActivityAlertAt ? Date.parse(user.activity.lastActivityAlertAt) : 0;
    const inactivityThresholdMs = attendanceDays * DAY_MS;

    const inactive =
        attendanceDays > 0
        && Number.isFinite(lastIncrease)
        && now - lastIncrease >= inactivityThresholdMs;

    if (inactive && now - lastAlert >= inactivityThresholdMs) {
        user.activity.lastActivityAlertAt = new Date(now).toISOString();
        return { inactive: true };
    }

    return { inactive: false };
}

async function applyClanIdentity(member, selectedClan, ign) {
    await assertCanApplyClanIdentity(member, selectedClan);

    const configuredRoleIds = Object.values(CLANS)
        .map(clan => clan.roleId)
        .filter(Boolean);

    const rolesToRemove = [...new Set([
        ...configuredRoleIds.filter(roleId => roleId !== selectedClan.roleId),
        ...CONFIG.rolesToRemoveOnRegister
    ])].filter(roleId => member.roles.cache.has(roleId));

    if (rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove, 'Updating registered clan role');
    }

    if (selectedClan.roleId) {
        await member.roles.add(selectedClan.roleId, 'Registered by stat bot');
    }

    if (CONFIG.fleetRoleId) {
        await member.roles.add(CONFIG.fleetRoleId, 'Registered by stat bot');
    }

    const nicknameUpdated = await trySetNickname(member, `[${selectedClan.label}] ${ign}`);

    return { nicknameUpdated };
}

async function assertCanApplyClanIdentity(member, selectedClan) {
    const botMember = member.guild.members.me || await member.guild.members.fetchMe();
    const rolesToManage = [];

    if (selectedClan.roleId) {
        const selectedRole = member.guild.roles.cache.get(selectedClan.roleId)
            || await member.guild.roles.fetch(selectedClan.roleId);

        if (!selectedRole) {
            throw new Error(`The configured Discord role for ${selectedClan.label} does not exist: ${selectedClan.roleId}`);
        }

        rolesToManage.push(selectedRole);
    }

    if (CONFIG.fleetRoleId) {
        const fleetRole = member.guild.roles.cache.get(CONFIG.fleetRoleId)
            || await member.guild.roles.fetch(CONFIG.fleetRoleId);

        if (!fleetRole) {
            throw new Error(`The configured fleet role does not exist: ${CONFIG.fleetRoleId}`);
        }

        rolesToManage.push(fleetRole);
    }

    for (const roleId of CONFIG.rolesToRemoveOnRegister) {
        const role = member.guild.roles.cache.get(roleId);

        if (!role) {
            console.warn(
                `Configured role does not exist, skipping: ${roleId}`
            );
            continue;
        }
    }

    if (rolesToManage.length > 0 && !botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        throw new Error('The bot needs the Manage Roles permission to assign clan roles.');
    }

    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageNicknames)) {
        throw new Error('The bot needs the Manage Nicknames permission to set registered nicknames.');
    }

    for (const role of rolesToManage) {
        if (role.managed) {
            throw new Error(`The ${role.name} role is managed by an integration and cannot be assigned by the bot.`);
        }

        if (role.position >= botMember.roles.highest.position) {
            throw new Error(`Move the bot's highest role above the ${role.name} role in Discord role settings.`);
        }
    }

    if (!member.manageable && member.id !== member.guild.ownerId) {
        console.warn('The bot cannot change this member nickname. Move the bot role above the member highest role.');
    }
}

async function trySetNickname(member, nickname) {
    if (!member.manageable) {
        return false;
    }

    await member.setNickname(nickname, 'Registered by stat bot');
    return true;
}

async function syncRegisteredNickname(member, user) {
    if (!user.clanTag || !user.ign) return false;

    const expectedNickname = `[${user.clanTag}] ${user.ign}`;
    if (member.nickname === expectedNickname) return false;

    try {
        return await trySetNickname(member, expectedNickname);
    } catch (error) {
        console.warn(`Failed to sync nickname for ${user.discordid}: ${error.message}`);
        return false;
    }
}

async function unregisterUserByAccountId(accountId, guild) {
    const data = await DataManager.readJSON();
    const userIndex = data.users.findIndex(user => String(user.id) === String(accountId));
    if (userIndex === -1) {
        return { removedUser: null, roleNote: null };
    }

    const [removedUser] = data.users.splice(userIndex, 1);
    await DataManager.saveJSON(data);

    let discordNote = null;
    if (guild) {
        discordNote = await removeRegistrationDiscordState(guild, removedUser);
    }

    return { removedUser, roleNote: discordNote };
}

async function removeRegistrationDiscordState(guild, removedUser) {
    const member = await fetchGuildMember(guild, removedUser.discordid);
    if (!member) return 'member not in Discord';

    const notes = [];
    notes.push(await removeRegistrationRoles(member));
    notes.push(await addUnregisterRoles(member));
    notes.push(await removeClanNickname(member, removedUser));

    return notes.filter(Boolean).join('; ');
}

async function removeRegistrationRoles(member) {
    const roleIds = getRegistrationRoleIds();
    if (roleIds.length === 0) return 'no registration roles configured';

    const rolesToRemove = roleIds.filter(roleId => member.roles.cache.has(roleId));
    if (rolesToRemove.length === 0) return 'no registration roles to remove';

    try {
        await member.roles.remove(rolesToRemove, 'Unregistered by stat bot');
        return 'registration roles removed';
    } catch (error) {
        console.warn(`Failed to remove registration roles for ${member.id}: ${error.message}`);
        return `role removal failed: ${error.message}`;
    }
}

async function addUnregisterRoles(member) {
    const roleIds = CONFIG.rolesToAddOnUnregister.filter(roleId => !member.roles.cache.has(roleId));
    if (roleIds.length === 0) {
        return CONFIG.rolesToAddOnUnregister.length > 0 ? 'post-unregister roles already present' : null;
    }

    try {
        await member.roles.add(roleIds, 'Unregistered by stat bot');
        return 'post-unregister roles added';
    } catch (error) {
        console.warn(`Failed to add unregister roles for ${member.id}: ${error.message}`);
        return `post-unregister role add failed: ${error.message}`;
    }
}

async function removeClanNickname(member, removedUser) {
    const cleanedNickname = getNicknameWithoutClanTag(member.nickname, removedUser);
    if (!cleanedNickname) return 'no clan tag nickname to remove';

    try {
        const nicknameUpdated = await trySetNickname(member, cleanedNickname);
        return nicknameUpdated ? 'clan tag removed from nickname' : 'nickname not manageable';
    } catch (error) {
        console.warn(`Failed to remove clan tag nickname for ${member.id}: ${error.message}`);
        return `nickname cleanup failed: ${error.message}`;
    }
}

function getNicknameWithoutClanTag(currentNickname, removedUser) {
    if (!currentNickname) return null;

    const expectedNickname = removedUser.clanTag && removedUser.ign
        ? `[${removedUser.clanTag}] ${removedUser.ign}`
        : null;

    if (expectedNickname && currentNickname === expectedNickname) {
        return removedUser.ign;
    }

    const configuredTags = Object.keys(CLANS).map(escapeRegExp).join('|');
    const clanTagPattern = configuredTags
        ? new RegExp(`^\\[(?:${configuredTags})\\]\\s*(.+)$`, 'i')
        : /^\[[^\]]+\]\s*(.+)$/;
    const match = currentNickname.match(clanTagPattern);

    if (!match) return null;
    return match[1]?.trim() || removedUser.ign || null;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getRegistrationRoleIds() {
    return [...new Set([
        ...Object.values(CLANS).map(clan => clan.roleId),
        CONFIG.fleetRoleId
    ].filter(Boolean))];
}

function formatUnregisterResult(result) {
    if (!result.removedUser) return 'That user is no longer registered.';

    const roleNote = result.roleNote ? ` ${result.roleNote}.` : '';
    return `Unregistered **${result.removedUser.ign}** (<@${result.removedUser.discordid}>).${roleNote}`;
}

function ensureClanCanManageDiscordRole(clan) {
    if (!clan.clanId) {
        throw new Error(`${clan.label} is missing its in-game clan ID. Set ${clan.envPrefix}_ID or ${envNameForClan(clan.label, 'CLAN_ID')}.`);
    }
}

function envNameForClan(clanTag, suffix) {
    return `${clanTag.replace('-', '_')}_${suffix}`;
}

function getClan(clanTag) {
    const clan = CLANS[clanTag];
    if (!clan) {
        throw new Error(`Unknown clan selection: ${clanTag}`);
    }

    return clan;
}

function statsFromLegacyUser(user) {
    const randomBattles = Number(user.gamesplayed || user.stats?.randomBattles || 0);
    const clanBattles = Number(user.clanBattles || user.stats?.clanBattles || 0);
    return {
        randomBattles,
        clanBattles,
        activityBattles: randomBattles + clanBattles,
        wins: 0,
        losses: 0,
        draws: 0,
        winRate: Number(user.winrate || 0),
        lastBattleTime: user.stats?.lastBattleTime || null
    };
}

function getActivityBattles(stats) {
    return Number(stats.randomBattles || 0) + Number(stats.clanBattles || 0);
}

async function getRegisteredRequesterTestSummary(discordId) {
    const data = await DataManager.readJSON();
    const registeredUser = data.users.find(user => String(user.discordid) === String(discordId));
    if (!registeredUser) return null;

    let stats = registeredUser.stats || statsFromLegacyUser(registeredUser);
    try {
        stats = await WargamingApi.getAccountStats(registeredUser.id) || stats;
        stats.clanBattles = await WargamingApi.getClanBattleStats(registeredUser.id);
        stats.activityBattles = getActivityBattles(stats);
    } catch (error) {
        console.warn(`Could not refresh test alert stats for ${registeredUser.id}: ${error.message}`);
    }

    return [
        'Requester registration snapshot:',
        `IGN: ${stats.nickname || registeredUser.ign}`,
        `Clan: ${registeredUser.clanTag || 'unknown'}`,
        `Account ID: ${registeredUser.id}`,
        `Random battles: ${stats.randomBattles}`,
        `Clan battles: ${stats.clanBattles || 0}`,
        `Activity battles: ${getActivityBattles(stats)}`,
        `Win rate: ${Number(stats.winRate || 0).toFixed(2)}%`,
        `Last battle: ${formatLastBattle(stats.lastBattleTime)}`,
        `Registered at: ${formatDateTime(registeredUser.registeredAt)}`,
        formatExemptionsMessage(registeredUser, normalizeExemptions(registeredUser), 'Exemptions')
    ].join('\n');
}

function formatLastBattle(lastBattleTime) {
    if (!lastBattleTime) return 'unknown';

    const timestampMs = Number(lastBattleTime) * 1000;
    if (!Number.isFinite(timestampMs)) return 'unknown';

    return `${formatDateTime(timestampMs)} (${formatDuration(Date.now() - timestampMs)} ago)`;
}

function formatDateTime(value) {
    const timestampMs = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(timestampMs)) return 'unknown';
    return new Date(timestampMs).toISOString();
}

function formatDuration(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return 'unknown';

    const days = Math.floor(durationMs / (24 * 60 * 60 * 1000));
    if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;

    const hours = Math.floor(durationMs / (60 * 60 * 1000));
    if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;

    const minutes = Math.floor(durationMs / (60 * 1000));
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

async function fetchGuildMember(guild, discordId) {
    try {
        return await guild.members.fetch(discordId);
    } catch (error) {
        return null;
    }
}

async function getGuildForDailyChecks() {
    if (CONFIG.guildId) {
        return client.guilds.fetch(CONFIG.guildId);
    }

    const firstGuild = client.guilds.cache.first();
    if (!firstGuild) {
        throw new Error('No guild is available for daily checks. Set DISCORD_GUILD_ID.');
    }

    return firstGuild;
}

async function dmUser(discordId, message) {
    try {
        const user = await client.users.fetch(discordId);
        await user.send(message);
    } catch (error) {
        console.warn(`Failed to DM ${discordId}: ${error.message}`);
    }
}

async function sendUnregisterActionAlert(user, alertText, channel) {
    const alertChannel = await client.channels.fetch(channel);
    if (!alertChannel) {
        throw new Error(`Alert channel ${channel} could not be fetched.`);
    }

    const button = new ButtonBuilder()
        .setCustomId(`unregister-user:${user.id}`)
        .setLabel(CONFIG.messages.unregisterButton.slice(0, 80))
        .setStyle(ButtonStyle.Danger);
    const row = new ActionRowBuilder().addComponents(button);

    await alertChannel.send({
        content: `${CONFIG.messages.dailyAlertHeader}\n- ${alertText}`,
        components: [row]
    });
}

async function disableButtonMessage(interaction, label) {
    const updatedRows = interaction.message.components.map(row => {
        const newRow = new ActionRowBuilder();
        const components = row.components.map(component =>
            ButtonBuilder.from(component)
                .setDisabled(true)
                .setLabel(label.slice(0, 80))
        );
        return newRow.addComponents(components);
    });

    await interaction.message.edit({ components: updatedRows });
}

async function replyOrEdit(interaction, content) {
    const payload = { content, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content });
    }

    return interaction.reply(payload);
}

async function sendChunkedInteractionReply(interaction, title, lines) {
    const chunks = chunkLines(lines, 1800);
    await interaction.editReply(`${title}\n${chunks.shift().join('\n')}`);

    for (const chunk of chunks) {
        await interaction.followUp({
            content: chunk.join('\n'),
            flags: MessageFlags.Ephemeral
        });
    }
}

function chunkLines(lines, maxLength) {
    const chunks = [];
    let current = [];
    let currentLength = 0;

    for (const line of lines) {
        if (current.length > 0 && currentLength + line.length + 1 > maxLength) {
            chunks.push(current);
            current = [];
            currentLength = 0;
        }

        current.push(line);
        currentLength += line.length + 1;
    }

    if (current.length > 0) chunks.push(current);
    return chunks;
}

function chunkArray(values, size) {
    const chunks = [];
    for (let i = 0; i < values.length; i += size) {
        chunks.push(values.slice(i, i + size));
    }
    return chunks;
}

function dedupeClanMembers(members) {
    const seen = new Set();
    return members.filter(member => {
        const key = `${member.clanTag}:${member.accountId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

class WargamingApi {
    static async findExactAccount(ign) {
        const response = await this.get('/account/list/', {
            search: ign,
            type: 'exact'
        });
        const accounts = response.data || [];
        return accounts.length === 1 ? accounts[0] : null;
    }

    static async getAccountStats(accountId) {
        const statsById = await this.getAccountStatsBatch([accountId]);
        return statsById.get(String(accountId)) || null;
    }

    static async getClanBattleStats(accountId) {
        const clanBattlesById = await this.getClanBattleStatsBatch([accountId]);
        return clanBattlesById.get(String(accountId)) || 0;
    }

    static async getAccountStatsBatch(accountIds) {
        const statsById = new Map();
        const ids = [...new Set(accountIds.map(String).filter(Boolean))];

        for (const chunk of chunkArray(ids, 100)) {
            const response = await this.get('/account/info/', {
                account_id: chunk.join(','),
                fields: 'account_id,nickname,last_battle_time,statistics.pvp.wins,statistics.pvp.losses,statistics.pvp.draws'
            });

            for (const [accountId, account] of Object.entries(response.data || {})) {
                if (!account?.statistics?.pvp) continue;
                const pvp = account.statistics.pvp;
                const randomBattles = Number(pvp.wins || 0) + Number(pvp.losses || 0) + Number(pvp.draws || 0);
                const winRate = randomBattles > 0 ? (Number(pvp.wins || 0) / randomBattles) * 100 : 0;

                statsById.set(String(accountId), {
                    accountId: String(account.account_id || accountId),
                    nickname: account.nickname,
                    randomBattles,
                    wins: Number(pvp.wins || 0),
                    losses: Number(pvp.losses || 0),
                    draws: Number(pvp.draws || 0),
                    winRate,
                    lastBattleTime: account.last_battle_time || null
                });
            }
        }

        return statsById;
    }

    static async getClanBattleStatsBatch(accountIds) {
        const clanBattlesById = new Map();
        const ids = [...new Set(accountIds.map(String).filter(Boolean))];

        for (const accountId of ids) {
            try {
                const response = await this.get('/clans/seasonstats/', {
                    account_id: accountId,
                    fields: 'account_id,seasons.battles'
                });

                for (const player of Object.values(response.data || {})) {
                    const totalBattles = (player.seasons || []).reduce(
                        (sum, season) => sum + (season.battles || 0),
                        0
                    );

                    clanBattlesById.set(String(player.account_id), totalBattles);
                }
            } catch (error) {
                console.error(
                    `Failed clan battle lookup for account ${accountId}:`,
                    error.message
                );
            }
        }

        return clanBattlesById;
    }

    static async countTier10ShipsPlayed(accountId) {
        const response = await this.get('/ships/stats/', {
            account_id: accountId,
            fields: 'ship_id,pvp.battles'
        });

        const shipStats = Object.values(response.data || {})[0] || [];
        const playedShipIds = shipStats
            .filter(ship => Number(ship?.pvp?.battles || 0) > 0)
            .map(ship => String(ship.ship_id));

        if (playedShipIds.length === 0) return 0;

        const tiersByShipId = await this.getShipTiers(playedShipIds);
        return playedShipIds.filter(shipId => tiersByShipId.get(String(shipId)) === 10).length;
    }

    static async getShipTiers(shipIds) {
        const tiersByShipId = new Map();
        const ids = [...new Set(shipIds.map(String).filter(Boolean))];

        for (const chunk of chunkArray(ids, 100)) {
            const response = await this.get('/encyclopedia/ships/', {
                ship_id: chunk.join(','),
                fields: 'ship_id,tier'
            });

            for (const [shipId, ship] of Object.entries(response.data || {})) {
                if (ship) tiersByShipId.set(String(shipId), Number(ship.tier));
            }
        }

        return tiersByShipId;
    }

    static async getConfiguredClanMembers(clanTag = null) {
        const members = [];
        const clans = clanTag
            ? [getClan(clanTag)]
            : Object.values(CLANS).filter(clan => clan.clanId);

        for (const clan of clans) {
            if (!clan.clanId) {
                throw new Error(`${clan.label} is missing its in-game clan ID. Set ${clan.envPrefix}_ID or ${envNameForClan(clan.label, 'CLAN_ID')}.`);
            }

            const response = await this.get('/clans/info/', {
                clan_id: clan.clanId,
                extra: 'members'
            });
            const clanData = response.data?.[clan.clanId];
            if (!clanData) {
                throw new Error(`${clan.label} returned no clan data for clan ID ${clan.clanId}. Check ${clan.envPrefix}_ID or ${envNameForClan(clan.label, 'CLAN_ID')}.`);
            }

            if (clanData.tag && clanData.tag !== clan.label) {
                throw new Error(`${clan.envPrefix}_ID points to [${clanData.tag}], not [${clan.label}]. Update the clan ID in .env.`);
            }

            const memberRows = Array.isArray(clanData?.members)
                ? clanData.members
                : Object.values(clanData?.members || {});
            const memberNamesById = new Map(memberRows
                .filter(member => member?.account_id)
                .map(member => [String(member.account_id), member.account_name]));
            const rosterIds = clanData.members_ids?.length
                ? clanData.members_ids.map(String)
                : memberRows.map(member => String(member.account_id)).filter(Boolean);

            for (const accountId of rosterIds) {
                members.push({
                    accountId: String(accountId),
                    nickname: memberNamesById.get(String(accountId)) || null,
                    clanTag: clan.label,
                    clanId: clan.clanId
                });
            }
        }

        return this.withMissingMemberNicknames(dedupeClanMembers(members));
    }

    static async withMissingMemberNicknames(members) {
        const missingNicknameIds = members
            .filter(member => !member.nickname)
            .map(member => member.accountId);

        if (missingNicknameIds.length === 0) return members;

        const nicknamesById = await this.getAccountNicknamesBatch(missingNicknameIds);
        return members.map(member => ({
            ...member,
            nickname: member.nickname || nicknamesById.get(String(member.accountId)) || null
        }));
    }

    static async getAccountNicknamesBatch(accountIds) {
        const nicknamesById = new Map();
        const ids = [...new Set(accountIds.map(String).filter(Boolean))];

        for (const chunk of chunkArray(ids, 100)) {
            const response = await this.get('/account/info/', {
                account_id: chunk.join(','),
                fields: 'account_id,nickname'
            });

            for (const [accountId, account] of Object.entries(response.data || {})) {
                if (account?.nickname) {
                    nicknamesById.set(String(account.account_id || accountId), account.nickname);
                }
            }
        }

        return nicknamesById;
    }

    static async get(path, params) {
        const response = await axios.get(`${WG_API_BASE}${path}`, {
            params: {
                application_id: CONFIG.wargamingApplicationId,
                ...params
            }
        });

        if (response.data?.status !== 'ok') {
            const message = response.data?.error?.message || 'Unknown Wargaming API error';
            throw new Error(`Wargaming API error: ${message}`);
        }

        return response.data;
    }
}

if (!CONFIG.discordToken) {
    console.error('DISCORD_BOT_TOKEN is required.');
    process.exit(1);
}

if (!CONFIG.alertChannelId) {
    console.error('ALERT_CHANNEL_ID is required.');
    process.exit(1);
}

client.login(CONFIG.discordToken);
