// Liste les conversations où le bot a reçu un message (pour trouver l'identifiant du groupe).
// N'affiche jamais le jeton. Usage : TELEGRAM_TOKEN=… node scripts/telegram_chats.mjs
const token = process.env.TELEGRAM_TOKEN;
if (!token) { console.log("TELEGRAM_TOKEN absent"); process.exit(1); }
const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json();
if (!me.ok) { console.log("Jeton refusé par Telegram :", me.description); process.exit(1); }
console.log(`Bot : @${me.result.username}`);
const up = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
const chats = new Map();
(up.result || []).forEach(u => { const c = (u.message || u.my_chat_member || u.channel_post || u.edited_message)?.chat; if (c) chats.set(c.id, c); });
if (!chats.size) console.log("Aucun message reçu : ajoute le bot au groupe puis écris un message dans le groupe.");
for (const c of chats.values()) console.log(`CHAT ${c.id} | ${c.type} | ${c.title || c.first_name || ""}`);
