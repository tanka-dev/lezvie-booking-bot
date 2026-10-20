// Бот записи клиентов для мастера (барбершоп «Лезвие»).
// Запуск:  node --env-file=.env bot.js
// .env:  BOT_TOKEN=...   ADMIN_ID=...  (ADMIN_ID — твой Telegram id, узнать командой /myid)

const fs = require("fs");
const { Bot, InlineKeyboard } = require("grammy");

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_ID = Number(process.env.ADMIN_ID || 0); // кому слать уведомления о записях

// ---------- настройки мастера (их меняют под каждого клиента-заказчика) ----------
const SERVICES = [
  { id: "cut", name: "Стрижка", price: 1000 },
  { id: "beard", name: "Борода", price: 600 },
  { id: "combo", name: "Стрижка + борода", price: 1400 },
];
const HOURS = ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00"];
const DAYS_AHEAD = 5; // на сколько дней вперёд можно записаться
const REMIND_BEFORE_HOURS = 2; // за сколько часов напоминать клиенту
const ADDRESS = "ул. Пушкина, 10";

// ---------- хранение записей в файле bookings.json ----------
const FILE = "bookings.json";
function loadBookings() {
  const list = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : [];
  // у старых записей могло не быть id — выдаём и сразу сохраняем, иначе при каждом чтении id будет новый
  const noId = list.filter((b) => !b.id);
  noId.forEach((b) => { b.id = Math.random().toString(36).slice(2, 9); });
  if (noId.length) fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  return list;
}
const saveBookings = (list) => fs.writeFileSync(FILE, JSON.stringify(list, null, 2));

const drafts = new Map(); // черновик записи, пока человек выбирает

// ---------- даты ----------
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
// "2026-10-21" из локальной даты (не через toISOString — тот даёт время по Гринвичу и ночью ошибается на день)
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// "чт, 21 октября" — как удобно читать человеку
function prettyDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return `${WEEKDAYS[date.getDay()]}, ${d} ${MONTHS[m - 1]}`;
}
// дата + время записи как объект Date (по местному времени)
const bookingDate = (b) => new Date(`${b.day}T${b.time}:00`);

function nextDays() {
  const out = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const iso = isoDay(d);
    out.push({ iso, label: i === 0 ? "Сегодня" : i === 1 ? "Завтра" : prettyDay(iso) });
  }
  return out;
}
const isTaken = (day, time) => loadBookings().some((b) => b.day === day && b.time === time);
// свободные часы: не заняты и (если сегодня) ещё не прошли
const freeHours = (day) =>
  HOURS.filter((h) => !isTaken(day, h) && new Date(`${day}T${h}:00`) > new Date());

const mainMenu = new InlineKeyboard()
  .text("✂️ Записаться", "book").row()
  .text("📋 Мои записи", "mine").row()
  .text("💰 Цены", "prices")
  .text("📍 Контакты", "contacts");

const notifyAdmin = (text) => (ADMIN_ID ? bot.api.sendMessage(ADMIN_ID, text) : null);

// ---------- команды ----------
bot.command("start", (ctx) =>
  ctx.reply(`Привет, ${ctx.from.first_name}! 👋\nЯ бот барбершопа «Лезвие». Чем помочь?`, { reply_markup: mainMenu }),
);
bot.command("myid", (ctx) => ctx.reply(`Твой id: ${ctx.from.id}`));
bot.command("zapisi", (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply("Эта команда только для мастера.");
  const list = loadBookings().filter((b) => bookingDate(b) > new Date()).sort((a, b) => bookingDate(a) - bookingDate(b));
  if (!list.length) return ctx.reply("Предстоящих записей нет.");
  ctx.reply("📋 Предстоящие записи:\n" + list.map((b) => `• ${prettyDay(b.day)}, ${b.time} — ${b.service} — ${b.name}`).join("\n"));
});

// ---------- меню ----------
bot.callbackQuery("prices", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("💰 Цены:\n" + SERVICES.map((s) => `• ${s.name} — ${s.price} ₽`).join("\n"), { reply_markup: mainMenu });
});
bot.callbackQuery("contacts", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(`📍 ${ADDRESS}\n🕙 Каждый день 10:00–21:00\n📞 +7 900 000-00-00`, { reply_markup: mainMenu });
});

// ---------- мои записи + отмена ----------
bot.callbackQuery("mine", async (ctx) => {
  await ctx.answerCallbackQuery();
  const mine = loadBookings()
    .filter((b) => b.userId === ctx.from.id && bookingDate(b) > new Date())
    .sort((a, b) => bookingDate(a) - bookingDate(b));
  if (!mine.length) return ctx.reply("У тебя нет предстоящих записей.", { reply_markup: mainMenu });
  const kb = new InlineKeyboard();
  mine.forEach((b) => kb.text(`❌ Отменить ${prettyDay(b.day)}, ${b.time}`, `del:${b.id}`).row());
  await ctx.reply(
    "📋 Твои записи:\n" + mine.map((b) => `• ${prettyDay(b.day)}, ${b.time} — ${b.service}`).join("\n"),
    { reply_markup: kb },
  );
});

bot.callbackQuery(/^del:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const list = loadBookings();
  const b = list.find((x) => x.id === ctx.match[1] && x.userId === ctx.from.id); // отменить можно только свою
  if (!b) return ctx.editMessageText("Эта запись уже отменена.");
  saveBookings(list.filter((x) => x !== b));
  await ctx.editMessageText(`Запись на ${prettyDay(b.day)}, ${b.time} отменена.`);
  await ctx.reply("Чем ещё помочь?", { reply_markup: mainMenu });
  await notifyAdmin(`❌ Запись отменена\n👤 ${b.name}\n✂️ ${b.service}\n📅 ${prettyDay(b.day)}, ${b.time}`);
});

// ---------- запись: услуга → день → время → подтверждение ----------
bot.callbackQuery("book", async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard();
  SERVICES.forEach((s) => kb.text(`${s.name} — ${s.price} ₽`, `svc:${s.id}`).row());
  await ctx.reply("Выбери услугу:", { reply_markup: kb });
});

bot.callbackQuery(/^svc:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const service = SERVICES.find((s) => s.id === ctx.match[1]);
  drafts.set(ctx.from.id, { service: service.name });
  const kb = new InlineKeyboard();
  nextDays().forEach((d, i) => { kb.text(d.label, `day:${d.iso}`); if (i % 2 === 1) kb.row(); });
  await ctx.editMessageText(`✂️ ${service.name}\nВыбери день:`, { reply_markup: kb });
});

bot.callbackQuery(/^day:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = drafts.get(ctx.from.id);
  if (!draft) return ctx.reply("Начни запись заново 👇", { reply_markup: mainMenu });
  draft.day = ctx.match[1];
  const free = freeHours(draft.day);
  if (!free.length) return ctx.editMessageText(`На ${prettyDay(draft.day)} свободного времени нет 😔`, { reply_markup: new InlineKeyboard().text("⬅️ Выбрать другой день", "book") });
  const kb = new InlineKeyboard();
  free.forEach((h, i) => { kb.text(h, `time:${h}`); if (i % 4 === 3) kb.row(); });
  await ctx.editMessageText(`✂️ ${draft.service}\n📅 ${prettyDay(draft.day)}\nВыбери время:`, { reply_markup: kb });
});

bot.callbackQuery(/^time:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = drafts.get(ctx.from.id);
  if (!draft) return ctx.reply("Начни запись заново 👇", { reply_markup: mainMenu });
  draft.time = ctx.match[1];
  const kb = new InlineKeyboard().text("✅ Подтвердить", "confirm").text("❌ Отмена", "cancel");
  await ctx.editMessageText(`Проверь запись:\n✂️ ${draft.service}\n📅 ${prettyDay(draft.day)}\n🕐 ${draft.time}`, { reply_markup: kb });
});

bot.callbackQuery("cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  drafts.delete(ctx.from.id);
  await ctx.editMessageText("Запись отменена.");
  await ctx.reply("Чем ещё помочь?", { reply_markup: mainMenu });
});

bot.callbackQuery("confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = drafts.get(ctx.from.id);
  if (!draft) return ctx.reply("Начни запись заново 👇", { reply_markup: mainMenu });
  if (isTaken(draft.day, draft.time)) return ctx.editMessageText("Ой, это время только что заняли 😔", { reply_markup: new InlineKeyboard().text("⬅️ Заново", "book") });

  const name = ctx.from.first_name + (ctx.from.username ? ` (@${ctx.from.username})` : "");
  const list = loadBookings();
  list.push({ id: Math.random().toString(36).slice(2, 9), ...draft, name, userId: ctx.from.id, reminded: false, createdAt: new Date().toISOString() });
  saveBookings(list);
  drafts.delete(ctx.from.id);

  await ctx.editMessageText(`✅ Ты записан!\n✂️ ${draft.service}\n📅 ${prettyDay(draft.day)}\n🕐 ${draft.time}\n\nЖдём тебя: ${ADDRESS}\nНапомню за ${REMIND_BEFORE_HOURS} часа 😉`);
  await ctx.reply("Чем ещё помочь?", { reply_markup: mainMenu });
  await notifyAdmin(`🔔 Новая запись!\n👤 ${name}\n✂️ ${draft.service}\n📅 ${prettyDay(draft.day)}, ${draft.time}`);
});

bot.on("message:text", (ctx) => ctx.reply("Нажми кнопку ниже 👇", { reply_markup: mainMenu }));

// ---------- напоминания ----------
// Раз в минуту смотрим записи: если до визита осталось меньше REMIND_BEFORE_HOURS часов и ещё не напоминали — напоминаем.
async function sendReminders() {
  const list = loadBookings();
  const now = new Date();
  let changed = false;
  for (const b of list) {
    const left = bookingDate(b) - now; // сколько миллисекунд до визита
    if (!b.reminded && left > 0 && left <= REMIND_BEFORE_HOURS * 3600 * 1000) {
      try {
        await bot.api.sendMessage(b.userId, `⏰ Напоминаю: сегодня в ${b.time} — ${b.service}.\n📍 ${ADDRESS}\nЕсли не получается прийти — отмени запись в «Мои записи».`);
      } catch (e) {
        console.error("Не удалось отправить напоминание:", e.message);
      }
      b.reminded = true;
      changed = true;
    }
  }
  if (changed) saveBookings(list);
}
setInterval(sendReminders, 60 * 1000);

bot.catch((err) => console.error("Ошибка:", err.message));
bot.start();
sendReminders();
console.log("Бот запущен! Открой его в Telegram и напиши /start");
