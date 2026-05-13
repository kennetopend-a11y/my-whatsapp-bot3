// index.js
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason 
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const P = require("pino");
const fs = require("fs");
const qrcode = require("qrcode-terminal");
const http = require("http");
const config = require("./config");

// ---- FIX 2: RENDER LIVE WEB PORT BINDING ----
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot active\n");
}).listen(PORT, () => {
    console.log(`[RENDER] Port validation running on ${PORT}`);
});
// ---------------------------------------------

const DB_FILE = "./database.json";
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }, null, 2));
}

function getDatabase() {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

function saveDatabase(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_session");

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // FIX 1: Prevent deprecation crash loops
        logger: P({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        // FIX 1: Generate safe visual QR blocks manually in logs
        if (qr) {
            console.log("\n==================================================");
            console.log("📷 SCAN THIS QR CODE WITH YOUR WHATSAPP LINKED DEVICES:");
            console.log("==================================================\n");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "close") {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
                ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut 
                : true;
            console.log("Reconnecting automatic loop status: ", shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === "open") {
            console.log(`\n======================================\n[SUCCESS] ${config.botName} IS LIVE!\n======================================\n`);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        try {
            if (type !== "notify") return;
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const from = msg.key.remoteJid;
            const isGroup = from.endsWith("@g.us");
            const sender = isGroup ? msg.key.participant : from;
            
            const body = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || "";
                         
            if (!body.startsWith(config.prefix)) return;

            const args = body.slice(config.prefix.length).trim().split(/ +/);
            const command = args.shift().toLowerCase();

            let db = getDatabase();
            if (!db.users[sender]) {
                db.users[sender] = { wallet: 15991, bank: 0, lastDaily: 0 };
            }
            let user = db.users[sender];

            const reply = async (text) => {
                await sock.sendMessage(from, { text: text }, { quoted: msg });
            };

            if (command === "bal" || command === "balance") {
                const balLayout = `

| 🏛️ WISTORIA ECONOMY
|
| 💵 Wallet: ${config.currencySymbol}${user.wallet.toLocaleString()}

| 🏛️ Wistoria: ${config.currencySymbol}${user.bank.toLocaleString()}
| 💎 Assets: ${config.currencySymbol}${(user.wallet + user.bank).toLocaleString()}
|
| 💠 Wistoria
`;
                await reply(balLayout.trim());
            }

            else if (command === "daily") {
                const now = Date.now();
                const cooldown = 24 * 60 * 60 * 1000;

                if (now - user.lastDaily < cooldown) {
                    return reply("⚠️ Daily bonus already claimed for today!");
                }

                user.wallet += config.dailyPayout;
                user.lastDaily = now;
                saveDatabase(db);
                await reply(`💰 DAILY CREDITED\n+${config.currencySymbol}${config.dailyPayout.toLocaleString()} added to wallet\n\n🏛️ wistoria economy`);
            }

            else if (command === "kick") {
                if (!isGroup) return reply("This is a group-restricted utility.");

                const groupMetadata = await sock.groupMetadata(from);
                const isSenderAdmin = groupMetadata.participants.find(p => p.id === sender)?.admin;
                
                if (sender !== config.ownerNumber && !isSenderAdmin) {
                    return reply("Failed to kick user(s): not-authorized");
                }

                let target = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?[0];
                if (!target && args[0]) {
                    target = `${args[0].replace(/[^0-9]/g, "")}@s.whatsapp.net`;
                }

                if (!target) return reply("Tag a user or input their phone number.");
                
                await sock.groupParticipantsUpdate(from, [target], "remove");
                await reply("User removed successfully.");
            }

        } catch (err) {
            console.error("Internal processing fault: ", err);
        }
    });
}

startBot();
