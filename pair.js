const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const yts = require("yt-search");
const fetch = require("node-fetch");
const api = `https://api-dark-shan-yt.koyeb.app`;
const apikey = `edbcfabbca5a9750`;

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent
} = require('@whiskeysockets/baileys');

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['🧩', '🍉', '💜', '🌸', '🪴', '💊', '💫', '🍂', '🌟', '🎋', '👀', '🤖', '🚩', '🥰', '🗿', '💙', '🌝'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/IH7Zu3bJrZs3d3Ber58BRu?mode=ems_copy_t',
    ADMIN_LIST_PATH: './admin.json',
    IMAGE_PATH: 'https://files.catbox.moe/iik6l0.png',
    NEWSLETTER_JID: '120363419230844309@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    NEWS_JSON_URL: '',
    BOT_NAME: 'NeroX BOT',
    OWNER_NAME: 'Dineth Sudarshana',
    OWNER_NUMBER: '94769983151',
    BOT_VERSION: '1.0.0',
    BOT_FOOTER: '> ᴍᴀɪɴᴛᴀɴᴀɴᴄᴇ ʙʏ ᴢᴇʀᴏ ʙᴜɢ ᴢᴏɴᴇ.',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbAUZUeJENy0fOUS5E3J',
    BUTTON_IMAGES: {
        MENU: 'https://files.catbox.moe/kus7ix.jpg'
    }
};

const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
});
const owner = process.env.GITHUB_REPO_OWNER;
const repo = process.env.GITHUB_REPO_NAME;

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `${title}\n\n${content}\n\n${footer}`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

async function cleanDuplicateFiles(number) {
    if (!owner || !repo) return;
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = Array.isArray(data) ? data.filter(file =>
            file.name.startsWith(`empire_${sanitizedNumber}_`) && file.name.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        }) : [];

        const configFiles = Array.isArray(data) ? data.filter(file =>
            file.name === `config_${sanitizedNumber}.json`
        ) : [];

        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await octokit.repos.deleteFile({
                    owner,
                    repo,
                    path: `session/${sessionFiles[i].name}`,
                    message: `Delete duplicate session file for ${sanitizedNumber}`,
                    sha: sessionFiles[i].sha
                });
                console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`);
            }
        }

        if (configFiles.length > 1) {
            console.log(`Config file for ${sanitizedNumber} already exists`);
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) {
        console.error('Invalid group invite link format');
        return { status: 'failed', error: 'Invalid group invite link' };
    }
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            if (response?.gid) {
                console.log(`Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message && error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message && error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message && error.message.includes('gone')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group, retries left: ${retries}`, errorMessage);
            if (retries === 0) {
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `Joined (ID: ${groupResult.gid})`
        : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(
        '*Connected Successful ✅*',
        `📞 Number: ${number}\n🩵 Status: Online\n🔗 Group: ${groupStatus}`,
        `${config.BOT_FOOTER}`
    );

    for (const admin of admins) {
        try {
            const adminJid = admin.includes('@') ? admin : `${admin}@s.whatsapp.net`;
            await socket.sendMessage(
                adminJid,
                {
                    image: { url: config.IMAGE_PATH },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: ${otp}\nThis OTP will expire in 5 minutes.`,
        `${config.BOT_FOOTER}`
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

async function updateAboutStatus(socket) {
    const aboutStatus = '¢увєр ηєт μιηι bσт is active now 🌸';
    try {
        await socket.updateProfileStatus(aboutStatus);
        console.log(`Updated About status to: ${aboutStatus}`);
    } catch (error) {
        console.error('Failed to update About status:', error);
    }
}

async function updateStoryStatus(socket) {
    const statusMessage = `Connected! 🚀\nConnected at: ${getSriLankaTimestamp()}`;
    try {
        await socket.sendMessage('status@broadcast', { text: statusMessage });
        console.log(`Posted story status: ${statusMessage}`);
    } catch (error) {
        console.error('Failed to post story status:', error);
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== config.NEWSLETTER_JID) return;

        try {
            const emojis = ['❤️', '👍'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No valid newsletterServerId found:', message);
                return;
            }

            let retries = config.MAX_RETRIES;
            while (retries > 0) {
                try {
                    if (socket.newsletterReactMessage) {
                        await socket.newsletterReactMessage(
                            config.NEWSLETTER_JID,
                            messageId.toString(),
                            randomEmoji
                        );
                        console.log(`Reacted to newsletter message ${messageId} with ${randomEmoji}`);
                    }
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to react to newsletter message ${messageId}, retries left: ${retries}`, error.message);
                    if (retries === 0) throw error;
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
        } catch (error) {
            console.error('Newsletter reaction error:', error);
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();

        const message = formatMessage(
            '*🗑️ MESSAGE DELETED*',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            `${config.BOT_FOOTER}`
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    const oyy = await Jimp.read(image);
    const kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    if (!string || typeof string !== 'string') return '';
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

async function SendSlide(socket, jid, newsItems) {
    let anu = [];
    for (let item of newsItems) {
        let imgBuffer;
        try {
            imgBuffer = await resize(item.thumbnail || config.IMAGE_PATH, 300, 200);
        } catch (error) {
            console.error(`Failed to resize image for ${item.title}:`, error);
            const fallback = await Jimp.read(config.IMAGE_PATH);
            imgBuffer = await fallback.resize(300, 200).getBufferAsync(Jimp.MIME_JPEG);
        }
        let imgsc = await prepareWAMessageMedia({ image: imgBuffer }, { upload: socket.waUploadToServer });
        anu.push({
            body: proto.Message.InteractiveMessage.Body.fromObject({
                text: `*${capital(item.title || 'News')}*\n\n${item.body || ''}`
            }),
            header: proto.Message.InteractiveMessage.Header.fromObject({
                hasMediaAttachment: true,
                ...imgsc
            }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                buttons: [
                    {
                        name: "cta_url",
                        buttonParamsJson: `{"display_text":"DEPLOY","url":"https://example.com","merchant_url":"https://example.com"}`
                    },
                    {
                        name: "cta_url",
                        buttonParamsJson: `{"display_text":"CONTACT","url":"https://wa.me/${config.OWNER_NUMBER}","merchant_url":"https://example.com"}`
                    }
                ]
            })
        });
    }
    const msgii = await generateWAMessageFromContent(jid, {
        viewOnceMessage: {
            message: {
                messageContextInfo: {
                    deviceListMetadata: {},
                    deviceListMetadataVersion: 2
                },
                interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                    body: proto.Message.InteractiveMessage.Body.fromObject({
                        text: "*Latest News Updates*"
                    }),
                    carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.fromObject({
                        cards: anu
                    })
                })
            }
        }
    }, { userJid: jid });
    return socket.relayMessage(jid, msgii.message, {
        messageId: msgii.key.id
    });
}

async function fetchNews() {
    if (!config.NEWS_JSON_URL) return [];
    try {
        const response = await axios.get(config.NEWS_JSON_URL);
        return response.data || [];
    } catch (error) {
        console.error('Failed to fetch news from raw JSON URL:', error.message);
        return [];
    }
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        // normalize sender number key usage
        const sanitizedNumber = String(number).replace(/[^0-9]/g, '');

        // Extract text reliably
        let rawText = '';
        if (msg.message.conversation) rawText = msg.message.conversation;
        else if (msg.message.extendedTextMessage?.text) rawText = msg.message.extendedTextMessage.text;
        else if (msg.message.buttonsResponseMessage?.selectedButtonId) rawText = msg.message.buttonsResponseMessage.selectedButtonId;
        else if (msg.message.listResponseMessage?.singleSelectReply?.selectedRowId) rawText = msg.message.listResponseMessage.singleSelectReply.selectedRowId;
        const text = (rawText || '').trim();
        if (!text) return;

        let command = null;
        let args = [];

        if (text.startsWith(config.PREFIX)) {
            const parts = text.slice(config.PREFIX.length).trim().split(/\s+/);
            command = parts[0].toLowerCase();
            args = parts.slice(1);
        }

        if (!command) return;

        try {
            switch (command) {
//================================ ALIVE ==================================
                case 'alive': {
                    const startTime = socketCreationTime.get(sanitizedNumber) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const title = '👋 I am Alive Now!';
                    const content = `I am Cyber Net Mini BOT.\n\n` +
                        `Version: ${config.BOT_VERSION}\n` +
                        `Host: Heroku\n` +
                        `Runtime: ${hours}h ${minutes}m ${seconds}s\n` +
                        `Owner: ${config.OWNER_NAME}\n\n` +
                        `This bot handles downloads, searches, utilities, and fun commands.`;
                    const footer = config.BOT_FOOTER;

                    await socket.sendMessage(msg.key.remoteJid, {
                        image: { url: config.IMAGE_PATH },
                        caption: formatMessage(title, content, footer),
                        quoted: msg
                    });
                    break;
                }
//================================ MENU ==================================
                case 'menu': {
                    const startTime = socketCreationTime.get(sanitizedNumber) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const title = `H E L L O W - MENU`;
                    const content = `Itz: NOVA~X\nType: MINI BOT\nPlatform: Heroku\nUpTime: ${hours}h ${minutes}m ${seconds}s\n\nCommands:\n- .song <name>\n- .video <query>\n- .ping\n- .owner`;
                    const footer = config.BOT_FOOTER;

                    await socket.sendMessage(msg.key.remoteJid, {
                        image: { url: config.BUTTON_IMAGES.MENU || config.IMAGE_PATH },
                        caption: formatMessage(title, content, footer),
                        buttons: [
                            { buttonId: `${config.PREFIX}downloadmenu`, buttonText: { displayText: 'DOWNLOAD' }, type: 1 },
                            { buttonId: `${config.PREFIX}ping`, buttonText: { displayText: 'CONVERT' }, type: 1 },
                            { buttonId: `${config.PREFIX}other`, buttonText: { displayText: 'OTHER' }, type: 1 },
                            { buttonId: `${config.PREFIX}owner`, buttonText: { displayText: 'OWNER' }, type: 1 }
                        ],
                        quoted: msg
                    });
                    break;
                }
                case 'downloadmenu': {
                    const startTime = socketCreationTime.get(sanitizedNumber) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    await socket.sendMessage(msg.key.remoteJid, {
                        react: {
                            text: "⬇️",
                            key: msg.key
                        }
                    });

                    const kariyane = `H E L L O W\nItz: NeroX Mini Bot\nPlatform: Render\nUpTime: ${hours}h ${minutes}m ${seconds}s\n\nAvailable download commands:\n- song\n- video\n- fb\n- ig\n- tiktok\n- mediafire\n- apk\n- gdrive\n\nAbout:\nCheck bot = ping\nConnectUs = owner\ndeploy = https://example.com`;

                    await socket.sendMessage(msg.key.remoteJid, {
                        image: { url: "https://files.catbox.moe/kus7ix.jpg" },
                        caption: kariyane,
                        contextInfo: {
                            mentionedJid: ['94766911711@s.whatsapp.net'],
                            forwardingScore: 999,
                            isForwarded: false,
                            externalAdReply: {
                                title: 'A multi device mini whatsapp bot ®',
                                body: 'NeroX Mini 🧼',
                                mediaType: 1,
                                sourceUrl: "https://example.com/",
                                thumbnailUrl: 'https://i.ibb.co/bg2MqkfW/Clicker-X-Md.jpg',
                                renderLargerThumbnail: false,
                                showAdAttribution: false
                            }
                        }
                    });
                    break;
                }
//============================ PING ==============================
                case 'ping': {
                    const initial = new Date().getTime();
                    let pingMsg = await socket.sendMessage(msg.key.remoteJid, { text: '*_Pinging to Cyber Net System Integration..._* ❗' });
                    const final = new Date().getTime();
                    await socket.sendMessage(msg.key.remoteJid, { text: '《 █▒▒▒▒▒▒▒▒▒▒▒》10%', edit: pingMsg.key });
                    await socket.sendMessage(msg.key.remoteJid, { text: '《 ████▒▒▒▒▒▒▒▒》30%', edit: pingMsg.key });
                    await socket.sendMessage(msg.key.remoteJid, { text: '《 ███████▒▒▒▒》50%', edit: pingMsg.key });
                    await socket.sendMessage(msg.key.remoteJid, { text: '《 ██████████▒》80%', edit: pingMsg.key });
                    await socket.sendMessage(msg.key.remoteJid, { text: '《 ████████████》100%', edit: pingMsg.key });

                    return await socket.sendMessage(msg.key.remoteJid, {
                        text: `*Pong ${final - initial} Ms*`,
                        edit: pingMsg.key
                    });
                }
//============================== OWNER ===============================
                case 'owner': {
                    const vcard = 'BEGIN:VCARD\n'
                        + 'VERSION:3.0\n'
                        + 'FN:SHALA OWNER\n'
                        + 'ORG:SHALA OWNER\n'
                        + 'TEL;type=CELL;type=VOICE;waid=94776702385:94770051298\n'
                        + 'EMAIL:cybernetmini@gmail.com\n'
                        + 'END:VCARD';

                    await socket.sendMessage(msg.key.remoteJid, {
                        contacts: {
                            displayName: "Cyber Net Mini Bot Ofc. Owner",
                            contacts: [{ vcard }]
                        }
                    });
                    break;
                }
//================================ SYSTEM ==================================
                case 'system': {
                    const startTime = socketCreationTime.get(sanitizedNumber) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const title = '*Cyber xmd System Info*';
                    const content = `Bot Name : ${config.BOT_NAME}\n` +
                        `Version : ${config.BOT_VERSION}\n` +
                        `Platform : Heroku\n` +
                        `Runtime : ${hours}h ${minutes}m ${seconds}s\n` +
                        `Owner : ${config.OWNER_NAME}`;
                    const footer = config.BOT_FOOTER;

                    await socket.sendMessage(msg.key.remoteJid, {
                        image: { url: config.IMAGE_PATH },
                        caption: formatMessage(title, content, footer)
                    });
                    break;
                }
//================================ JID ==================================
                case 'jid': {
                    await socket.sendMessage(msg.key.remoteJid, {
                        text: `*🆔 Chat JID:* ${msg.key.remoteJid}`
                    });
                    break;
                }
//================================ BOOM ==================================
                case 'boom': {
                    if (args.length < 2) {
                        return await socket.sendMessage(msg.key.remoteJid, {
                            text: "📛 *Usage:* `.boom <count> <message>`\n📌 *Example:* `.boom 100 Hello`"
                        });
                    }

                    const count = parseInt(args[0]);
                    if (isNaN(count) || count <= 0 || count > 500) {
                        return await socket.sendMessage(msg.key.remoteJid, {
                            text: "❗ Please provide a valid count between 1 and 500."
                        });
                    }

                    const message = args.slice(1).join(" ");
                    for (let i = 0; i < count; i++) {
                        await socket.sendMessage(msg.key.remoteJid, { text: message });
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }

                    break;
                }
//================================ SONG ==================================
                case 'song': {
                    try {
                        const q = args.join(' ').trim();
                        if (!q) {
                            await socket.sendMessage(msg.key.remoteJid, { text: '*🚫 Please enter a song name to search.*' });
                            return;
                        }

                        const searchResults = await yts(q);
                        if (!searchResults || !searchResults.videos || searchResults.videos.length === 0) {
                            await socket.sendMessage(msg.key.remoteJid, { text: '*🚩 Result Not Found*' });
                            return;
                        }

                        const video = searchResults.videos[0];

                        // ==== API CALL ====
                        const apiUrl = `${api}/download/ytmp3?url=${encodeURIComponent(video.url)}&apikey=${apikey}`;
                        const response = await fetch(apiUrl);
                        const data = await response.json();

                        if (!data || !data.status || !data.data?.result) {
                            await socket.sendMessage(msg.key.remoteJid, { text: '*🚩 Download Error. Please try again later.*' });
                            return;
                        }

                        const { title, uploader, duration, quality, format, thumbnail, download } = data.data.result || {};

                        const titleText = '*✘ Cyber Net Songs*';
                        const content = `Title : ${video.title}\nViews : ${video.views}\nDuration : ${video.timestamp}\nURL : ${video.url}`;

                        const footer = config.BOT_FOOTER || '';
                        const captionMessage = formatMessage(titleText, content, footer);

                        await socket.sendMessage(msg.key.remoteJid, {
                            image: { url: video.thumbnail || thumbnail || config.IMAGE_PATH },
                            caption: captionMessage
                        });

                        if (download) {
                            await socket.sendMessage(msg.key.remoteJid, {
                                audio: { url: download },
                                mimetype: 'audio/mpeg'
                            });

                            await socket.sendMessage(msg.key.remoteJid, {
                                document: { url: download },
                                mimetype: "audio/mpeg",
                                fileName: `${(video.title || title || 'audio')}.mp3`,
                                caption: captionMessage
                            });
                        } else {
                            await socket.sendMessage(msg.key.remoteJid, { text: '*❌ Download link not available.*' });
                        }

                    } catch (err) {
                        console.error(err);
                        await socket.sendMessage(msg.key.remoteJid, { text: '*❌ Internal Error. Please try again later.*' });
                    }

                    break;
                }
//================================ NEWS ==================================
                case 'news': {
                    await socket.sendMessage(msg.key.remoteJid, {
                        text: '📰 Fetching latest news...'
                    });
                    const newsItems = await fetchNews();
                    if (!newsItems || newsItems.length === 0) {
                        await socket.sendMessage(msg.key.remoteJid, {
                            image: { url: config.IMAGE_PATH },
                            caption: formatMessage(
                                '🗂️ NO NEWS AVAILABLE',
                                '❌ No news updates found at the moment. Please try again later.',
                                `${config.BOT_FOOTER}`
                            )
                        });
                    } else {
                        await SendSlide(socket, msg.key.remoteJid, newsItems.slice(0, 5));
                    }
                    break;
                }
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(msg.key.remoteJid, {
                image: { url: config.IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    `${config.BOT_FOOTER}`
                )
            });
        }

    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

async function deleteSessionFromGitHub(number) {
    if (!owner || !repo) return;
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = Array.isArray(data) ? data.filter(file =>
            file.name.includes(sanitizedNumber) && file.name.endsWith('.json')
        ) : [];

        for (const file of sessionFiles) {
            await octokit.repos.deleteFile({
                owner,
                repo,
                path: `session/${file.name}`,
                message: `Delete session for ${sanitizedNumber}`,
                sha: file.sha
            });
        }
    } catch (error) {
        console.error('Failed to delete session from GitHub:', error);
    }
}

async function restoreSession(number) {
    if (!owner || !repo) return null;
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = Array.isArray(data) ? data.filter(file =>
            file.name === `creds_${sanitizedNumber}.json`
        ) : [];

        if (sessionFiles.length === 0) return null;

        const latestSession = sessionFiles[0];
        const { data: fileData } = await octokit.repos.getContent({
            owner,
            repo,
            path: `session/${latestSession.name}`
        });

        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    if (!owner || !repo) return { ...config };
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: configPath
        });

        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    if (!owner || !repo) throw new Error('GitHub owner/repo not configured');
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        let sha;

        try {
            const { data } = await octokit.repos.getContent({
                owner,
                repo,
                path: configPath
            });
            sha = data.sha;
        } catch (error) {
            // file might not exist - create new
        }

        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: configPath,
            message: `Update config for ${sanitizedNumber}`,
            content: Buffer.from(JSON.stringify(newConfig, null, 2)).toString('base64'),
            sha
        });
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
            console.log(`Connection lost for ${number}, attempting to reconnect...`);
            await delay(10000);
            const normalized = String(number).replace(/[^0-9]/g, '');
            activeSockets.delete(normalized);
            socketCreationTime.delete(normalized);
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
            } catch (e) {
                console.error('Re-pair failed:', e);
            }
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = String(number).replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState?.creds?.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    if (socket.requestPairingCode) {
                        code = await socket.requestPairingCode(sanitizedNumber);
                        break;
                    } else {
                        console.warn('requestPairingCode not supported by this baileys version');
                        break;
                    }
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}`, error);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            try {
                const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
                let sha;
                try {
                    const { data } = await octokit.repos.getContent({
                        owner,
                        repo,
                        path: `session/creds_${sanitizedNumber}.json`
                    });
                    sha = data.sha;
                } catch (error) {
                    // file may not exist yet
                }

                if (owner && repo) {
                    await octokit.repos.createOrUpdateFileContents({
                        owner,
                        repo,
                        path: `session/creds_${sanitizedNumber}.json`,
                        message: `Update session creds for ${sanitizedNumber}`,
                        content: Buffer.from(fileContent).toString('base64'),
                        sha
                    });
                    console.log(`Updated creds for ${sanitizedNumber} in GitHub`);
                }
            } catch (err) {
                console.error('Failed to read/write creds to GitHub:', err);
            }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    await updateAboutStatus(socket);
                    await updateStoryStatus(socket);

                    const groupResult = await joinGroup(socket);

                    try {
                        if (socket.newsletterFollow) {
                            await socket.newsletterFollow(config.NEWSLETTER_JID);
                        }
                        if (socket.sendMessage) {
                            await socket.sendMessage(config.NEWSLETTER_JID, { react: { text: '❤️', key: { id: config.NEWSLETTER_MESSAGE_ID } } });
                        }
                        console.log('✅ Auto-followed newsletter & reacted ❤️');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    // store active socket using sanitized number
                    activeSockets.set(sanitizedNumber, socket);

                    const groupStatus = groupResult.status === 'success'
                        ? 'Joined successfully'
                        : `Failed to join group: ${groupResult.error}`;

                    const connectMessage = formatMessage(
                        '*🧚‍♂️ Cyber Net Mini*',
                        `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n🍁 Channel: ${config.NEWSLETTER_JID ? 'Followed' : 'Not followed'}\n\n📋 Available Category:\n📌 General`,
                        config.BOT_FOOTER
                    );

                    await socket.sendMessage(userJid, {
                        image: { url: config.IMAGE_PATH },
                        caption: connectMessage
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    let numbers = [];
                    if (fs.existsSync(NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || 'Shala-Md-Free-Bot-Session'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    const normalized = String(number).replace(/[^0-9]/g, '');
    if (activeSockets.has(normalized)) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: 'BOT is running',
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (!numbers || numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            const normalized = String(number).replace(/[^0-9]/g, '');
            if (activeSockets.has(normalized)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
            await delay(500); // small throttle
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    if (!owner || !repo) {
        return res.status(500).send({ error: 'GitHub owner/repo not configured' });
    }
    try {
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = Array.isArray(data) ? data.filter(file =>
            file.name.startsWith('creds_') && file.name.endsWith('.json')
        ) : [];

        if (sessionFiles.length === 0) {
            return res.status(404).send({ error: 'No session files found in GitHub repository' });
        }

        const results = [];
        for (const file of sessionFiles) {
            const match = file.name.match(/creds_(\d+)\.json/);
            if (!match) {
                console.warn(`Skipping invalid session file: ${file.name}`);
                results.push({ file: file.name, status: 'skipped', reason: 'invalid_file_name' });
                continue;
            }

            const number = match[1];
            const normalized = String(number).replace(/[^0-9]/g, '');
            if (activeSockets.has(normalized)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = String(number).replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = String(number).replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.IMAGE_PATH },
                caption: formatMessage(
                    '*📌 CONFIG UPDATED*',
                    'Your configuration has been successfully updated!',
                    `${config.BOT_FOOTER}`
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = String(number).replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        try {
            if (socket && socket.ws && socket.ws.close) socket.ws.close();
        } catch (e) {
            // ignore
        }
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    try {
        fs.emptyDirSync(SESSION_BASE_PATH);
    } catch (e) {
        console.warn('Failed to empty session dir on exit:', e);
    }
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    try {
        exec(`pm2 restart ${process.env.PM2_NAME || 'BOT-session'}`);
    } catch (e) {
        console.error('Failed to restart pm2:', e);
    }
});

module.exports = router;
