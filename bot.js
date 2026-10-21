// Бот записи клиентов для мастера (барбершоп «Лезвие»).
// Запуск:  node --env-file=.env bot.js
// .env:  BOT_TOKEN=...   ADMIN_ID=...  (ADMIN_ID — Telegram id мастера, узнать командой /myid)

const fs = require("fs");
const { Bot, InlineKeyboard, Keyboard } = require("grammy");

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_ID = Number(process.env.ADMIN_ID || 0); // мастер: получает уведомления и видит /master
const WEBAPP_URL = process.env.WEBAPP_URL || ""; // адрес окна записи (Mini App), https://…/ ; пусто — только запись в чате
const WEB_PORT = Number(process.env.WEB_PORT || 3000); // порт, на котором бот отдаёт окно записи (снаружи его закрывает HTTPS-сервер Caddy)

// ======================= НАСТРОЙКИ МАСТЕРА =======================
// Под нового заказчика меняется только этот блок.
const SALON = "барбершоп «Лезвие»";
const CITY = "Рязань";
const ADDRESS = "ул. Пушкина, 10";
const SALON_PHONE = "+7 900 000-00-00";
// minutes — сколько длится услуга: следующего клиента бот не запишет, пока этот не закончит
const SERVICES = [
  { id: "cut", name: "Стрижка", price: 1000, minutes: 60 },
  { id: "beard", name: "Борода", price: 600, minutes: 30 },
  { id: "combo", name: "Стрижка + борода", price: 1400, minutes: 90 },
];
// график по дням недели: [открытие, закрытие]; null — выходной
const SCHEDULE = {
  пн: ["10:00", "21:00"],
  вт: ["10:00", "21:00"],
  ср: ["10:00", "21:00"],
  чт: ["10:00", "21:00"],
  пт: ["10:00", "21:00"],
  сб: ["10:00", "18:00"],
  вс: null,
};
const STEP_MINUTES = 30; // шаг записи: 10:00, 10:30, 11:00…
const DAYS_AHEAD = 7; // на сколько дней вперёд можно записаться
const MAX_ACTIVE = 2; // сколько будущих записей может быть у одного клиента (защита от шутников)
const DAY_REMIND_AT = "18:00"; // во сколько накануне спрашивать «Придёте?»
const REMIND_BEFORE_HOURS = 2; // за сколько часов до визита напомнить ещё раз
const DIGEST_AT = "09:00"; // во сколько мастеру приходит сводка на день
// ссылка для отзывов (лучше — прямая ссылка на карточку салона в Яндекс Картах или 2ГИС); "" — не просить отзыв
const REVIEW_LINK = `https://yandex.ru/maps/?text=${encodeURIComponent(`${SALON} ${CITY}`)}`;
const REVIEW_AFTER_HOURS = 2; // через сколько часов после визита попросить отзыв
const MAP_LINK = `https://yandex.ru/maps/?text=${encodeURIComponent(`${CITY}, ${ADDRESS}`)}`;
// =================================================================

// ---------- хранение данных в файлах ----------
const readJson = (file, empty) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : empty);
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

// записи — bookings.json
const FILE = "bookings.json";
function loadBookings() {
  const list = readJson(FILE, []);
  // у старых записей могло не быть id — выдаём и сразу сохраняем, иначе при каждом чтении id будет новый
  const noId = list.filter((b) => !b.id);
  noId.forEach((b) => { b.id = Math.random().toString(36).slice(2, 9); });
  if (noId.length) writeJson(FILE, list);
  return list;
}
const saveBookings = (list) => writeJson(FILE, list);

// телефоны клиентов — users.json: спрашиваем один раз, дальше помним
const USERS_FILE = "users.json";
const getUser = (userId) => readJson(USERS_FILE, {})[userId]; // { phone, verified }
// verified = true — номер пришёл кнопкой из Telegram (точно настоящий), false — клиент написал сам
function savePhone(userId, phone, verified) {
  const users = readJson(USERS_FILE, {});
  users[userId] = { phone, verified, savedAt: Date.now() };
  writeJson(USERS_FILE, users);
}
// номер, набранный руками → "+79001234567" или null, если на номер не похоже
function parsePhone(text) {
  const digits = text.replace(/\D/g, "");
  if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) return "+7" + digits.slice(1);
  if (digits.length === 10 && digits[0] === "9") return "+7" + digits;
  if (text.trim().startsWith("+") && digits.length >= 10 && digits.length <= 15) return "+" + digits; // номера других стран
  return null;
}

// выходные и закрытые часы — closed.json (мастер управляет сам через /master)
const CLOSED_FILE = "closed.json";
const loadClosed = () => readJson(CLOSED_FILE, { days: [], slots: [] });
const saveClosed = (c) => writeJson(CLOSED_FILE, c);
const isDayClosed = (day) => loadClosed().days.includes(day);
const isSlotClosed = (day, time) => {
  const c = loadClosed();
  return c.days.includes(day) || c.slots.includes(`${day} ${time}`);
};

// служебное — state.json (например, в какой день уже отправили сводку мастеру)
const STATE_FILE = "state.json";
const loadState = () => readJson(STATE_FILE, {});
const saveState = (s) => writeJson(STATE_FILE, s);

const drafts = new Map(); // черновик записи, пока человек выбирает

// ---------- даты ----------
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
// "2026-10-21" из локальной даты (не через toISOString — тот даёт время по Гринвичу и ночью ошибается на день)
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayAfter = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d); }; // 0 — сегодня, 1 — завтра
// "чт, 21 октября" — как удобно читать человеку
function prettyDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return `${WEEKDAYS[date.getDay()]}, ${d} ${MONTHS[m - 1]}`;
}
const shortDay = (iso) => prettyDay(iso).replace(/ [а-я]+$/, "").replace(",", ""); // "ср 21"
// дата + время записи как объект Date (по местному времени)
const bookingDate = (b) => new Date(`${b.day}T${b.time}:00`);
// сейчас уже позже, чем "18:00" сегодня?
const nowAfter = (hhmm) => { const n = new Date(); return n.getHours() * 60 + n.getMinutes() >= toMin(hhmm); };

function nextDays(count = DAYS_AHEAD) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const iso = dayAfter(i);
    out.push({ iso, label: i === 0 ? "Сегодня" : i === 1 ? "Завтра" : prettyDay(iso) });
  }
  return out;
}

// ---------- время, график и длительность ----------
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; }; // "10:30" → 630
const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; // 630 → "10:30"
// 90 → "1 ч 30 мин"
const durText = (min) => [Math.floor(min / 60) && `${Math.floor(min / 60)} ч`, min % 60 && `${min % 60} мин`].filter(Boolean).join(" ");
const durOf = (b) => b.minutes || 60; // у старых записей длительности нет — считаем час
const endDate = (b) => new Date(bookingDate(b).getTime() + durOf(b) * 60000);
const timeRange = (b) => `${b.time}–${toTime(toMin(b.time) + durOf(b))}`; // "10:00–11:30"

const weekdayOf = (iso) => { const [y, m, d] = iso.split("-").map(Number); return WEEKDAYS[new Date(y, m - 1, d).getDay()]; };
const workHours = (iso) => SCHEDULE[weekdayOf(iso)]; // null — выходной по графику
// все «клеточки» рабочего дня с шагом STEP_MINUTES: ["10:00", "10:30", …]
function daySlots(iso) {
  const wh = workHours(iso);
  if (!wh) return [];
  const out = [];
  for (let m = toMin(wh[0]); m < toMin(wh[1]); m += STEP_MINUTES) out.push(toTime(m));
  return out;
}
// запись, которая занимает эту клеточку (или undefined)
const bookingAt = (iso, time, list = loadBookings()) =>
  list.find((b) => b.day === iso && toMin(b.time) <= toMin(time) && toMin(time) < toMin(b.time) + durOf(b));

// можно ли начать услугу длиной minutes в это время: рабочий день, успеваем до закрытия, не прошло, все клеточки свободны
function canStart(iso, time, minutes, list = loadBookings()) {
  const wh = workHours(iso);
  if (!wh || isDayClosed(iso)) return false;
  const start = toMin(time);
  const end = start + minutes;
  if (end > toMin(wh[1])) return false;
  if (new Date(`${iso}T${time}:00`) <= new Date()) return false;
  for (let m = start; m < end; m += STEP_MINUTES) {
    const t = toTime(m);
    if (isSlotClosed(iso, t) || bookingAt(iso, t, list)) return false;
  }
  return true;
}
// свободное время для услуги нужной длины
const freeStarts = (iso, minutes) => {
  const list = loadBookings();
  return daySlots(iso).filter((t) => canStart(iso, t, minutes, list));
};

// график для «Контактов»: "пн–пт: 10:00–21:00 / сб: 10:00–18:00 / вс: выходной"
function scheduleText() {
  const order = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
  const val = (d) => (SCHEDULE[d] ? SCHEDULE[d].join("–") : "выходной");
  const parts = [];
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && val(order[j + 1]) === val(order[i])) j++;
    parts.push(`${i === j ? order[i] : `${order[i]}–${order[j]}`}: ${val(order[i])}`);
    i = j + 1;
  }
  return parts.join("\n🕙 ");
}

const upcoming = () => loadBookings().filter((b) => bookingDate(b) > new Date()).sort((a, b) => bookingDate(a) - bookingDate(b));
const myUpcoming = (userId) => upcoming().filter((b) => b.userId === userId);

// ---------- клавиатуры ----------
// Постоянные кнопки внизу экрана (вместо клавиатуры) — видны всегда, не уезжают вверх с сообщениями
const BTN = { book: "✂️ Записаться", mine: "📋 Мои записи", prices: "💰 Цены", contacts: "📍 Контакты" };
const mainMenu = new Keyboard()
  .text(BTN.book).row()
  .text(BTN.mine).row()
  .text(BTN.prices).text(BTN.contacts)
  .resized()     // кнопки компактные, а не на пол-экрана
  .persistent(); // не прячутся после нажатия

// Кнопка «Отправить номер»: Telegram сам подставляет номер аккаунта — его нельзя выдумать или ввести с ошибкой
// «Ввести другой номер» — если звонить нужно не на тот номер, к которому привязан Telegram
const PHONE_MANUAL = "✏️ Ввести другой номер";
const PHONE_CANCEL = "❌ Отмена";
const phoneKb = new Keyboard().requestContact("📱 Отправить мой номер").row().text(PHONE_MANUAL).row().text(PHONE_CANCEL).resized();
const phoneChange = new Set(); // кто сейчас меняет номер командой /nomer (без записи)

const notifyAdmin = (text) => (ADMIN_ID ? bot.api.sendMessage(ADMIN_ID, text).catch((e) => console.error("Мастеру не отправилось:", e.message)) : null);
// редактируем сообщение; ошибку «текст не изменился» спокойно пропускаем
const edit = (ctx, text, kb) => ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
const isAdmin = (ctx) => ctx.from.id === ADMIN_ID;

// ---------- команды ----------
bot.command("start", async (ctx) => {
  await ctx.reply(`Здравствуйте, ${ctx.from.first_name}! 👋\nЯ бот онлайн-записи в ${SALON}.`, { reply_markup: mainMenu });
  if (WEBAPP_URL) {
    const kb = new InlineKeyboard().webApp("📅 Записаться онлайн", WEBAPP_URL);
    await ctx.reply("Выберите услугу, день и время в удобном окне — это займёт полминуты 👇", { reply_markup: kb });
  }
});
bot.command("myid", (ctx) => ctx.reply(`Ваш id: ${ctx.from.id}`));

// ---------- панель мастера: /master ----------
const MASTER_DAYS = 14; // на сколько дней вперёд мастер видит график
const masterKb = new InlineKeyboard().text("📋 Записи", "adm:list").row().text("🗓 График и выходные", "adm:days");
if (WEBAPP_URL) masterKb.row().webApp("💈 Открыть кабинет мастера", WEBAPP_URL + "?tab=master");
bot.command("master", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Эта команда только для мастера.");
  return ctx.reply("🛠 Панель мастера", { reply_markup: masterKb });
});

// строка записи для мастера; ✅ — клиент подтвердил, что придёт
const adminLine = (b) =>
  `${timeRange(b)} — ${b.service} — ${b.name}${b.phone ? `, ${b.phone}` : ""}${b.confirmed ? " ✅ подтвердил" : ""}`;

// список записей с кнопками отмены
function listView() {
  const list = upcoming();
  const kb = new InlineKeyboard();
  list.forEach((b) => kb.text(`❌ ${shortDay(b.day)}, ${b.time} — ${b.name.split(" ")[0]}`, `adel:${b.id}`).row());
  kb.text("⬅️ Назад", "adm:menu");
  const text = list.length
    ? "📋 Предстоящие записи:\n" + list.map((b) => `• ${prettyDay(b.day)}, ${adminLine(b)}`).join("\n") + "\n\nНажми на запись, чтобы отменить её."
    : "Предстоящих записей нет.";
  return { text, kb };
}
bot.command("zapisi", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Эта команда только для мастера.");
  const { text, kb } = listView();
  return ctx.reply(text, { reply_markup: kb });
});

// список дней: где выходной, где сколько записей
function daysView() {
  const kb = new InlineKeyboard();
  const all = loadBookings();
  for (const d of nextDays(MASTER_DAYS)) {
    const n = all.filter((b) => b.day === d.iso).length;
    const mark = !workHours(d.iso) ? "🚫 выходной по графику" : isDayClosed(d.iso) ? "🚫 выходной" : n ? `👤 ${n}` : "";
    kb.text(`${prettyDay(d.iso)}${mark ? "  ·  " + mark : ""}`, `aday:${d.iso}`).row();
  }
  kb.text("⬅️ Назад", "adm:menu");
  return { text: "🗓 Выбери день, чтобы закрыть его или отдельные часы:", kb };
}

// один день: клеточки времени с состояниями
function dayView(iso) {
  if (!workHours(iso)) {
    return {
      text: `📅 ${prettyDay(iso)} — выходной по графику.\nГрафик меняется в настройках бота (SCHEDULE).`,
      kb: new InlineKeyboard().text("⬅️ К списку дней", "adm:days"),
    };
  }
  const closedDay = isDayClosed(iso);
  const list = loadBookings();
  const kb = new InlineKeyboard();
  daySlots(iso).forEach((h, i) => {
    const icon = bookingAt(iso, h, list) ? "👤" : isSlotClosed(iso, h) ? "🚫" : "✅";
    kb.text(`${icon} ${h}`, `aslot:${iso}|${h}`);
    if (i % 4 === 3) kb.row();
  });
  kb.row();
  kb.text(closedDay ? "✅ Сделать рабочим" : "🚫 Сделать выходным", `${closedDay ? "aopen" : "aclose"}:${iso}`).row();
  kb.text("⬅️ К списку дней", "adm:days");
  const text = `📅 ${prettyDay(iso)}${closedDay ? " — ВЫХОДНОЙ" : ""}\n✅ свободно · 👤 запись · 🚫 закрыто\nНажми на время, чтобы закрыть или открыть его.`;
  return { text, kb };
}

// все кнопки панели мастера проверяют, что нажал именно мастер
bot.callbackQuery(/^(adm|adel|adelok|aday|aslot|aclose|aopen):?(.*)$/, async (ctx, next) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: "Только для мастера", show_alert: true });
  return next();
});

bot.callbackQuery("adm:menu", async (ctx) => { await ctx.answerCallbackQuery(); await edit(ctx, "🛠 Панель мастера", masterKb); });
bot.callbackQuery("adm:list", async (ctx) => { await ctx.answerCallbackQuery(); const v = listView(); await edit(ctx, v.text, v.kb); });
bot.callbackQuery("adm:days", async (ctx) => { await ctx.answerCallbackQuery(); const v = daysView(); await edit(ctx, v.text, v.kb); });
bot.callbackQuery(/^aday:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const v = dayView(ctx.match[1]); await edit(ctx, v.text, v.kb); });

// мастер отменяет запись: сначала переспрашиваем, чтобы не отменить случайно
bot.callbackQuery(/^adel:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const b = loadBookings().find((x) => x.id === ctx.match[1]);
  if (!b) { const v = listView(); return edit(ctx, "Эта запись уже отменена.\n\n" + v.text, v.kb); }
  const kb = new InlineKeyboard().text("✅ Да, отменить", `adelok:${b.id}`).text("⬅️ Нет", "adm:list");
  await edit(ctx, `Отменить запись?\n👤 ${b.name}${b.phone ? `, ${b.phone}` : ""}\n✂️ ${b.service}\n📅 ${prettyDay(b.day)}, ${timeRange(b)}\n\nКлиенту придёт сообщение об отмене.`, kb);
});
// мастер отменяет запись (из чата или из окна): удаляем и пишем клиенту; возвращает запись или null
async function cancelByMaster(id) {
  const list = loadBookings();
  const b = list.find((x) => x.id === id);
  if (!b) return null;
  saveBookings(list.filter((x) => x !== b));
  try {
    await bot.api.sendMessage(
      b.userId,
      `😔 К сожалению, мастер отменил вашу запись:\n✂️ ${b.service}\n📅 ${prettyDay(b.day)}, ${b.time}\n\nВыберите другое время — нажмите «✂️ Записаться» 👇`,
      { reply_markup: mainMenu },
    );
  } catch (e) {
    await notifyAdmin(`⚠️ Не удалось написать клиенту ${b.name} (возможно, он заблокировал бота). Позвони: ${b.phone || "номера нет"}`);
  }
  return b;
}
bot.callbackQuery(/^adelok:(.+)$/, async (ctx) => {
  const b = await cancelByMaster(ctx.match[1]);
  if (!b) { await ctx.answerCallbackQuery(); const v = listView(); return edit(ctx, v.text, v.kb); }
  await ctx.answerCallbackQuery({ text: "Запись отменена, клиент уведомлён" });
  const v = listView();
  await edit(ctx, `✅ Отменил: ${prettyDay(b.day)}, ${b.time} — ${b.name}\n\n` + v.text, v.kb);
});

// закрыть/открыть отдельное время
bot.callbackQuery(/^aslot:(.+)\|(.+)$/, async (ctx) => {
  const [, iso, h] = ctx.match;
  if (bookingAt(iso, h)) return ctx.answerCallbackQuery({ text: "На это время есть запись. Отмени её в «📋 Записи».", show_alert: true });
  if (isDayClosed(iso)) return ctx.answerCallbackQuery({ text: "Весь день выходной. Сначала сделай его рабочим.", show_alert: true });
  const c = loadClosed();
  const key = `${iso} ${h}`;
  c.slots = c.slots.includes(key) ? c.slots.filter((s) => s !== key) : [...c.slots, key];
  saveClosed(c);
  await ctx.answerCallbackQuery({ text: c.slots.includes(key) ? `${h} закрыто` : `${h} открыто` });
  const v = dayView(iso);
  await edit(ctx, v.text, v.kb);
});

// весь день — выходной / рабочий
bot.callbackQuery(/^aclose:(.+)$/, async (ctx) => {
  const iso = ctx.match[1];
  const c = loadClosed();
  if (!c.days.includes(iso)) c.days.push(iso);
  saveClosed(c);
  const n = loadBookings().filter((b) => b.day === iso).length;
  await ctx.answerCallbackQuery(
    n ? { text: `День закрыт для новых записей. Но на него уже есть записи (${n}) — если нужно, отмени их в «📋 Записи».`, show_alert: true } : { text: "Выходной 🚫" },
  );
  const v = dayView(iso);
  await edit(ctx, v.text, v.kb);
});
bot.callbackQuery(/^aopen:(.+)$/, async (ctx) => {
  const iso = ctx.match[1];
  const c = loadClosed();
  c.days = c.days.filter((d) => d !== iso);
  saveClosed(c);
  await ctx.answerCallbackQuery({ text: "День снова рабочий ✅" });
  const v = dayView(iso);
  await edit(ctx, v.text, v.kb);
});

// ---------- разделы меню ----------
// Каждый раздел — отдельная функция: её вызывают и кнопка внизу, и команда из «Меню», и старые кнопки в сообщениях
const showPrices = (ctx) =>
  ctx.reply("💰 Цены:\n" + SERVICES.map((s) => `• ${s.name} — ${s.price} ₽ (${durText(s.minutes)})`).join("\n"), { reply_markup: mainMenu });

// контакты + кнопка, которая открывает адрес в Яндекс Картах
const showContacts = (ctx) =>
  ctx.reply(`📍 ${CITY}, ${ADDRESS}\n🕙 ${scheduleText()}\n📞 ${SALON_PHONE}`, {
    reply_markup: new InlineKeyboard().url("🗺 Как добраться — открыть карту", MAP_LINK),
  });

async function showBook(ctx) {
  // защита от шутников: не больше MAX_ACTIVE будущих записей на человека (мастера не ограничиваем)
  const mine = myUpcoming(ctx.from.id);
  if (!isAdmin(ctx) && mine.length >= MAX_ACTIVE) {
    return ctx.reply(
      `У вас уже ${mine.length} записи — это максимум 🙂\nЧтобы записаться ещё раз, отмените одну из них в «📋 Мои записи».`,
      { reply_markup: mainMenu },
    );
  }
  // если окно записи (Mini App) настроено — предлагаем его, запись в чате остаётся запасным вариантом
  if (WEBAPP_URL) {
    const kb = new InlineKeyboard().webApp("📅 Открыть онлайн-запись", WEBAPP_URL).row().text("💬 Записаться в чате", "chatbook");
    return ctx.reply("Выберите услугу, день и время в удобном окне 👇", { reply_markup: kb });
  }
  return showServices(ctx);
}
// запись прямо в чате: список услуг кнопками
async function showServices(ctx) {
  const kb = new InlineKeyboard();
  SERVICES.forEach((s) => kb.text(`${s.name} — ${s.price} ₽ · ${durText(s.minutes)}`, `svc:${s.id}`).row());
  await ctx.reply("Выберите услугу:", { reply_markup: kb });
}
bot.callbackQuery("chatbook", async (ctx) => { await ctx.answerCallbackQuery(); await showServices(ctx); });

async function showMine(ctx) {
  const mine = myUpcoming(ctx.from.id);
  if (!mine.length) return ctx.reply("У вас нет предстоящих записей.", { reply_markup: mainMenu });
  const kb = new InlineKeyboard();
  mine.forEach((b) => kb.text(`❌ Отменить ${prettyDay(b.day)}, ${b.time}`, `del:${b.id}`).row());
  await ctx.reply(
    "📋 Ваши записи:\n" + mine.map((b) => `• ${prettyDay(b.day)}, ${timeRange(b)} — ${b.service}`).join("\n"),
    { reply_markup: kb },
  );
}

// одна функция — три способа её вызвать
const sections = [
  { key: "book", cmd: "zapis", fn: showBook },
  { key: "mine", cmd: "moi", fn: showMine },
  { key: "prices", cmd: "ceny", fn: showPrices },
  { key: "contacts", cmd: "kontakty", fn: showContacts },
];
for (const s of sections) {
  bot.hears(BTN[s.key], s.fn); // кнопка внизу экрана
  bot.command(s.cmd, s.fn); // команда из «Меню»
  bot.callbackQuery(s.key, async (ctx) => { await ctx.answerCallbackQuery(); await s.fn(ctx); }); // кнопки в сообщениях
}

// ---------- клиент отменяет свою запись (из «Мои записи» или из напоминания) ----------
// общая отмена для чата и Mini App: отменить можно только свою запись; возвращает запись или null
async function cancelByClient(userId, id) {
  const list = loadBookings();
  const b = list.find((x) => x.id === id && x.userId === userId);
  if (!b) return null;
  saveBookings(list.filter((x) => x !== b));
  await notifyAdmin(`❌ Клиент отменил запись\n👤 ${b.name}${b.phone ? `\n📞 ${b.phone}` : ""}\n✂️ ${b.service}\n📅 ${prettyDay(b.day)}, ${timeRange(b)}`);
  return b;
}
bot.callbackQuery(/^del:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const b = await cancelByClient(ctx.from.id, ctx.match[1]);
  if (!b) return edit(ctx, "Эта запись уже отменена.");
  await edit(ctx, `Запись на ${prettyDay(b.day)}, ${b.time} отменена.`);
  await ctx.reply("Хорошо, запись отменена. Будем рады видеть вас в другой раз! 👇", { reply_markup: mainMenu });
});

// ---------- клиент подтверждает визит (кнопка из напоминания накануне) ----------
bot.callbackQuery(/^cfm:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const list = loadBookings();
  const b = list.find((x) => x.id === ctx.match[1] && x.userId === ctx.from.id);
  if (!b) return edit(ctx, "Эта запись уже отменена.");
  if (b.confirmed) return;
  b.confirmed = true;
  saveBookings(list);
  await edit(ctx, `Отлично, ждём вас ${prettyDay(b.day)} в ${b.time}! 💈\n📍 ${ADDRESS}`);
  await notifyAdmin(`✅ Клиент подтвердил визит\n👤 ${b.name}\n📅 ${prettyDay(b.day)}, ${timeRange(b)} — ${b.service}`);
});

// ---------- запись: услуга → день → время → подтверждение ----------
bot.callbackQuery(/^svc:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const service = SERVICES.find((s) => s.id === ctx.match[1]);
  if (!service) return ctx.reply("Эта услуга больше недоступна. Выберите заново 👇", { reply_markup: mainMenu });
  drafts.set(ctx.from.id, { service: service.name, minutes: service.minutes });
  // показываем только дни, где есть свободное время под эту услугу (выходные и занятые дни скрыты)
  const days = nextDays().filter((d) => freeStarts(d.iso, service.minutes).length);
  if (!days.length) return edit(ctx, `✂️ ${service.name}\nНа ближайшие дни свободного времени нет 😔 Позвоните нам: ${SALON_PHONE}`);
  const kb = new InlineKeyboard();
  days.forEach((d, i) => { kb.text(d.label, `day:${d.iso}`); if (i % 2 === 1) kb.row(); });
  await edit(ctx, `✂️ ${service.name}\nВыберите день:`, kb);
});

bot.callbackQuery(/^day:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = drafts.get(ctx.from.id);
  if (!draft) return ctx.reply("Начните запись заново 👇", { reply_markup: mainMenu });
  draft.day = ctx.match[1];
  const free = freeStarts(draft.day, draft.minutes);
  if (!free.length) return edit(ctx, `На ${prettyDay(draft.day)} свободного времени нет 😔`, new InlineKeyboard().text("⬅️ Выбрать другой день", "book"));
  const kb = new InlineKeyboard();
  free.forEach((h, i) => { kb.text(h, `time:${h}`); if (i % 4 === 3) kb.row(); });
  await edit(ctx, `✂️ ${draft.service}\n📅 ${prettyDay(draft.day)}\nВыберите время:`, kb);
});

bot.callbackQuery(/^time:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = drafts.get(ctx.from.id);
  if (!draft) return ctx.reply("Начните запись заново 👇", { reply_markup: mainMenu });
  draft.time = ctx.match[1];
  const kb = new InlineKeyboard().text("✅ Подтвердить", "confirm").text("❌ Отмена", "cancel");
  await edit(ctx, `Проверьте запись:\n✂️ ${draft.service}\n📅 ${prettyDay(draft.day)}\n🕐 ${timeRange(draft)}`, kb);
});

bot.callbackQuery("cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  drafts.delete(ctx.from.id);
  await edit(ctx, "Запись отменена.");
  await ctx.reply("Чем ещё помочь?", { reply_markup: mainMenu });
});

bot.callbackQuery("confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = drafts.get(ctx.from.id);
  if (!draft) return ctx.reply("Начните запись заново 👇", { reply_markup: mainMenu });
  if (!canStart(draft.day, draft.time, draft.minutes)) return edit(ctx, "Ой, это время только что заняли 😔", new InlineKeyboard().text("⬅️ Выбрать другое", "book"));

  // убираем кнопки «Подтвердить/Отмена», чтобы не нажали второй раз
  await edit(ctx, `Проверьте запись:\n✂️ ${draft.service}\n📅 ${prettyDay(draft.day)}\n🕐 ${timeRange(draft)}`);
  if (getUser(ctx.from.id)?.phone) return finishBooking(ctx, draft);

  // номера ещё нет — просим один раз, запись завершится, когда он придёт
  draft.waitPhone = true;
  await ctx.reply(
    "Остался один шаг 👇\nНажмите «📱 Отправить мой номер» — мастер сможет позвонить, если что-то изменится.\nЕсли звонить лучше на другой номер — нажмите «✏️ Ввести другой номер». Спросим только один раз." +
      (WEBAPP_URL ? `\n\nОтправляя номер, вы соглашаетесь на обработку персональных данных: ${WEBAPP_URL}policy.html` : ""),
    { reply_markup: phoneKb, link_preview_options: { is_disabled: true } },
  );
});

// номер с пометкой для мастера: настоящий из Telegram или написанный клиентом
const phoneLine = (u) => `${u.phone} ${u.verified ? "(из Telegram ✅)" : "(указал сам)"}`;

const bookedText = (b) =>
  `✅ Вы записаны!\n✂️ ${b.service}\n📅 ${prettyDay(b.day)}\n🕐 ${timeRange(b)}\n\nЖдём вас: ${ADDRESS}\nНапомним о визите заранее 😉`;

// одна запись — общая для чата и Mini App. from — пользователь Telegram, draft — { service, minutes, day, time }.
// Возвращает { booking } или { error: "need_phone" | "taken" | "limit" }
async function createBooking(from, draft) {
  const user = getUser(from.id);
  if (!user?.phone) return { error: "need_phone" };
  if (!canStart(draft.day, draft.time, draft.minutes)) return { error: "taken" };
  if (from.id !== ADMIN_ID && myUpcoming(from.id).length >= MAX_ACTIVE) return { error: "limit" };

  const name = from.first_name + (from.username ? ` (@${from.username})` : "");
  // напоминание «Придёте?» шлём накануне в DAY_REMIND_AT; если записались позже — уже не нужно
  const tooLateForDayRemind = draft.day === dayAfter(0) || (draft.day === dayAfter(1) && nowAfter(DAY_REMIND_AT));
  const booking = {
    id: Math.random().toString(36).slice(2, 9),
    service: draft.service, minutes: draft.minutes, day: draft.day, time: draft.time,
    price: SERVICES.find((x) => x.name === draft.service)?.price ?? 0,
    name, phone: user.phone, userId: from.id,
    dayReminded: tooLateForDayRemind, reminded: false, reviewAsked: false, confirmed: false,
    createdAt: new Date().toISOString(),
  };
  const list = loadBookings();
  list.push(booking);
  saveBookings(list);
  await notifyAdmin(`🔔 Новая запись!\n👤 ${name}\n📞 ${phoneLine(user)}\n✂️ ${booking.service}\n📅 ${prettyDay(booking.day)}, ${timeRange(booking)}`);
  return { booking };
}

// запись из чата: сохраняем и отвечаем клиенту
async function finishBooking(ctx, draft) {
  drafts.delete(ctx.from.id);
  const r = await createBooking(ctx.from, draft);
  if (r.error === "taken") return ctx.reply("Ой, это время только что заняли 😔 Выберите другое 👇", { reply_markup: mainMenu });
  if (r.error === "limit") return ctx.reply(`У вас уже ${MAX_ACTIVE} записи — это максимум. Отмените одну в «📋 Мои записи».`, { reply_markup: mainMenu });
  await ctx.reply(bookedText(r.booking), { reply_markup: mainMenu });
}

// ---------- номер телефона ----------
// ждём ли мы от человека номер: при записи или при смене номера
const waitingPhone = (id) => drafts.get(id)?.waitPhone || phoneChange.has(id);

// номер получен (кнопкой или текстом) — сохраняем и продолжаем то, что человек делал
async function phoneReceived(ctx, phone, verified) {
  savePhone(ctx.from.id, phone, verified);
  phoneChange.delete(ctx.from.id);
  const draft = drafts.get(ctx.from.id);
  if (draft?.waitPhone) return finishBooking(ctx, draft);
  await ctx.reply(`Номер сохранён 👍 ${phone}`, { reply_markup: mainMenu });
}

// клиент нажал «Отправить мой номер»
bot.on("message:contact", async (ctx) => {
  const contact = ctx.message.contact;
  // проверка: номер должен быть от этого же аккаунта, а не пересланный чужой контакт
  if (contact.user_id !== ctx.from.id) {
    return ctx.reply("Это чужой контакт 🙂 Нажмите «📱 Отправить мой номер» или «✏️ Ввести другой номер».", { reply_markup: phoneKb });
  }
  const phone = contact.phone_number.startsWith("+") ? contact.phone_number : `+${contact.phone_number}`;
  await phoneReceived(ctx, phone, true);
});

bot.hears(PHONE_MANUAL, (ctx) =>
  ctx.reply("Напишите номер, на который вам звонить, например: +7 900 123-45-67", { reply_markup: phoneKb }),
);

bot.hears(PHONE_CANCEL, async (ctx) => {
  const hadDraft = drafts.delete(ctx.from.id);
  phoneChange.delete(ctx.from.id);
  await ctx.reply(hadDraft ? "Запись отменена." : "Хорошо, номер не меняем.", { reply_markup: mainMenu });
});

// /nomer — поменять сохранённый номер
bot.command("nomer", (ctx) => {
  phoneChange.add(ctx.from.id);
  const u = getUser(ctx.from.id);
  return ctx.reply(`${u?.phone ? `Сейчас у вас номер ${u.phone}.\n` : ""}Отправьте новый номер кнопкой или напишите его 👇`, { reply_markup: phoneKb });
});

bot.on("message:text", async (ctx) => {
  // пока ждём номер, пробуем понять его из текста
  if (waitingPhone(ctx.from.id)) {
    const phone = parsePhone(ctx.message.text);
    if (phone) return phoneReceived(ctx, phone, false);
    return ctx.reply("Не похоже на номер 🤔 Напишите так: +7 900 123-45-67 — или нажмите «📱 Отправить мой номер».", { reply_markup: phoneKb });
  }
  return ctx.reply("Выберите кнопку внизу 👇", { reply_markup: mainMenu });
});

// ---------- раз в минуту: напоминания, отзывы, сводка мастеру ----------
async function send(userId, text, kb) {
  try {
    await bot.api.sendMessage(userId, text, kb ? { reply_markup: kb } : undefined);
  } catch (e) {
    console.error("Не удалось отправить сообщение:", e.message);
  }
}

async function tick() {
  const list = loadBookings();
  const now = new Date();
  let changed = false;
  const reviewedNow = new Set(); // кому уже отправили просьбу об отзыве в этот раз — второй не шлём

  for (const b of list) {
    const left = bookingDate(b) - now; // сколько миллисекунд до визита

    // накануне вечером: «Придёте?» с кнопками (только до 22:00, чтобы не будить людей)
    if (!b.dayReminded && b.day === dayAfter(1) && nowAfter(DAY_REMIND_AT) && !nowAfter("22:00")) {
      const kb = new InlineKeyboard().text("✅ Приду", `cfm:${b.id}`).text("❌ Отменить запись", `del:${b.id}`);
      await send(b.userId, `👋 Напоминаем: завтра, ${prettyDay(b.day)}, в ${b.time} — ${b.service}.\n📍 ${ADDRESS}\n\nПодтвердите, пожалуйста, что придёте:`, kb);
      b.dayReminded = true;
      changed = true;
    }

    // за REMIND_BEFORE_HOURS часа до визита
    if (!b.reminded && left > 0 && left <= REMIND_BEFORE_HOURS * 3600 * 1000) {
      const kb = new InlineKeyboard().url("🗺 Как добраться", MAP_LINK).row().text("❌ Не смогу прийти", `del:${b.id}`);
      await send(b.userId, `⏰ Напоминаем: сегодня в ${b.time} — ${b.service}.\n📍 ${ADDRESS}`, kb);
      b.reminded = true;
      changed = true;
    }

    // после визита — попросить отзыв: только по свежим визитам (за сутки), днём (10:00–21:00) и один раз на человека
    const sinceEnd = now - endDate(b);
    const daytime = nowAfter("10:00") && !nowAfter("21:00");
    if (REVIEW_LINK && !b.reviewAsked && daytime && sinceEnd >= REVIEW_AFTER_HOURS * 3600 * 1000 && sinceEnd < 24 * 3600 * 1000) {
      if (!reviewedNow.has(b.userId)) {
        const kb = new InlineKeyboard().url("⭐ Оставить отзыв", REVIEW_LINK).row().text("✂️ Записаться снова", "book");
        await send(b.userId, "Спасибо, что были у нас! 🙏\nКак всё прошло? Будем очень благодарны за отзыв — это займёт минуту.", kb);
        reviewedNow.add(b.userId);
      }
      b.reviewAsked = true;
      changed = true;
    }
  }
  if (changed) saveBookings(list);

  // раз в день удаляем данные старше года (так обещано в политике обработки данных)
  const st0 = loadState();
  if (st0.cleanDay !== dayAfter(0)) {
    const yearAgo = Date.now() - 365 * 24 * 3600 * 1000;
    const keep = loadBookings().filter((b) => bookingDate(b).getTime() > yearAgo);
    saveBookings(keep);
    const users = readJson(USERS_FILE, {});
    const active = new Set(keep.map((b) => String(b.userId)));
    for (const id of Object.keys(users)) {
      if (!users[id].savedAt) users[id].savedAt = Date.now(); // номер сохранён до появления даты — считаем свежим
      if (!active.has(id) && users[id].savedAt < yearAgo) delete users[id];
    }
    writeJson(USERS_FILE, users);
    const c = loadClosed();
    const today = dayAfter(0);
    saveClosed({ days: c.days.filter((d) => d >= today), slots: c.slots.filter((x) => x.slice(0, 10) >= today) }); // прошедшие выходные больше не нужны
    saveState({ ...st0, cleanDay: dayAfter(0) });
  }

  // утренняя сводка мастеру — один раз в день, в первые 3 часа после DIGEST_AT
  const state = loadState();
  const today = dayAfter(0);
  if (ADMIN_ID && state.digestDay !== today && nowAfter(DIGEST_AT)) {
    if (!nowAfter(toTime(toMin(DIGEST_AT) + 180))) {
      const todays = list.filter((b) => b.day === today).sort((a, b) => toMin(a.time) - toMin(b.time));
      const text = todays.length
        ? `☀️ Доброе утро! Сегодня, ${prettyDay(today)}, записей: ${todays.length}\n` + todays.map((b) => `• ${adminLine(b)}`).join("\n")
        : `☀️ Доброе утро! На сегодня, ${prettyDay(today)}, записей пока нет.`;
      await notifyAdmin(text);
    }
    saveState({ ...state, digestDay: today });
  }
}
if (process.env.WEB_ONLY !== "1") setInterval(() => tick().catch((e) => console.error("Ошибка в напоминаниях:", e.message)), 60 * 1000);

// ---------- профиль бота в Telegram ----------
// Кнопка «Меню» слева от поля ввода и текст «Что умеет этот бот?», который видно в пустом чате до нажатия «Старт»
async function setupProfile() {
  try {
    const clientCommands = [
      { command: "zapis", description: "✂️ Записаться" },
      { command: "moi", description: "📋 Мои записи" },
      { command: "ceny", description: "💰 Цены" },
      { command: "kontakty", description: "📍 Контакты и как добраться" },
      { command: "nomer", description: "📞 Изменить номер телефона" },
      { command: "start", description: "🏠 Главное меню" },
    ];
    await bot.api.setMyCommands(clientCommands);
    // у мастера в «Меню» дополнительно его команды — клиенты их не видят
    if (ADMIN_ID) {
      await bot.api.setMyCommands(
        [{ command: "master", description: "🛠 Панель мастера" }, { command: "zapisi", description: "📋 Все записи" }, ...clientCommands],
        { scope: { type: "chat", chat_id: ADMIN_ID } },
      );
    }
    // кнопка слева от поля ввода открывает окно записи
    if (WEBAPP_URL) await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Записаться", web_app: { url: WEBAPP_URL } } });
    await bot.api.setMyDescription(
      `Онлайн-запись в ${SALON} ✂️\n\n• Запись за 30 секунд — без звонков и переписки\n• Видно только свободное время\n• Напомним о визите накануне и за ${REMIND_BEFORE_HOURS} часа\n• Отменить запись — в один клик\n\nНажмите «Старт» 👇`,
    );
    await bot.api.setMyShortDescription(`Онлайн-запись в ${SALON} — без звонков, с напоминанием о визите.`);
  } catch (e) {
    console.error("Не удалось обновить профиль бота:", e.message);
  }
}

// ======================= ОКНО ЗАПИСИ (Mini App) =======================
// Бот сам раздаёт страницу webapp/index.html и отвечает ей данными (/api/...).
// Снаружи всё это закрыто HTTPS-сервером Caddy: https://…sslip.io → localhost:WEB_PORT
const http = require("http");
const crypto = require("crypto");
const path = require("path");

// Telegram подписывает данные пользователя токеном бота — проверяем подпись, подделать её нельзя.
// Возвращает пользователя { id, first_name, username } или null
function checkInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(params.get("auth_date")) > 24 * 3600) return null; // подпись старше суток — не принимаем
  try { return JSON.parse(params.get("user")); } catch { return null; }
}

// день для окна: «пн», «21», «окт», сколько свободных окошек
function dayCard(iso, minutes) {
  const [y, m, d] = iso.split("-").map(Number);
  const free = freeStarts(iso, minutes).length;
  const i = nextDays().findIndex((x) => x.iso === iso);
  return { iso, weekday: weekdayOf(iso), day: d, month: MONTHS[m - 1].slice(0, 3), label: i === 0 ? "Сегодня" : i === 1 ? "Завтра" : "", free, off: !workHours(iso) || isDayClosed(iso) };
}
const myBookingsView = (userId) =>
  myUpcoming(userId).map((b) => ({ id: b.id, service: b.service, day: b.day, pretty: prettyDay(b.day), range: timeRange(b), confirmed: !!b.confirmed }));

const API = {
  // всё, что окну нужно знать о салоне
  "GET /api/config": () => ({
    salon: SALON, city: CITY, address: ADDRESS, phone: SALON_PHONE, mapLink: MAP_LINK, schedule: scheduleText().split("\n🕙 "),
    services: SERVICES.map((s) => ({ id: s.id, name: s.name, price: s.price, minutes: s.minutes, dur: durText(s.minutes) })),
  }),
  // дни на DAYS_AHEAD вперёд с количеством свободного времени под услугу
  "GET /api/days": (q) => {
    const s = SERVICES.find((x) => x.id === q.get("service"));
    if (!s) return { error: "service" };
    return nextDays().map((d) => dayCard(d.iso, s.minutes));
  },
  // свободное время на день под услугу
  "GET /api/slots": (q) => {
    const s = SERVICES.find((x) => x.id === q.get("service"));
    if (!s) return { error: "service" };
    return freeStarts(q.get("day") || "", s.minutes).map((t) => ({ time: t, end: toTime(toMin(t) + s.minutes) }));
  },
  // кто я: номер (если уже есть) и мои записи
  "POST /api/me": (_, body, user) => ({ phone: getUser(user.id)?.phone || null, bookings: myBookingsView(user.id) }),
  // номер, введённый руками в окне
  "POST /api/phone": (_, body, user) => {
    const phone = parsePhone(String(body.phone || ""));
    if (!phone) return { error: "phone" };
    savePhone(user.id, phone, false);
    return { phone };
  },
  // записаться
  "POST /api/book": async (_, body, user) => {
    const s = SERVICES.find((x) => x.id === body.service);
    if (!s) return { error: "service" };
    const r = await createBooking(user, { service: s.name, minutes: s.minutes, day: String(body.day), time: String(body.time) });
    if (r.error) return r;
    // дублируем подтверждение в чат — чтобы запись осталась перед глазами
    await send(user.id, bookedText(r.booking), mainMenu);
    return { booking: { id: r.booking.id, service: r.booking.service, pretty: prettyDay(r.booking.day), range: timeRange(r.booking), address: ADDRESS } };
  },
  // отменить свою запись
  "POST /api/cancel": async (_, body, user) => {
    const b = await cancelByClient(user.id, String(body.id));
    return b ? { ok: true, bookings: myBookingsView(user.id) } : { error: "gone" };
  },
};

// ---------- кабинет мастера в окне ----------
// Мастер (ADMIN_ID) видит и меняет настоящие записи. Любой другой видит ДЕМО: примерные записи,
// которые живут только в памяти и только для него — так будущий заказчик может «потрогать» кабинет.
const priceOf = (b) => b.price ?? SERVICES.find((s) => s.name === b.service)?.price ?? 0;

// простой генератор случайных чисел с «зерном» — у каждого гостя свои, но постоянные примерные записи
function seeded(seed) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const DEMO_NAMES = ["Анна", "Ольга", "Мария", "Дмитрий", "Ирина", "Сергей", "Екатерина", "Алексей", "Наталья", "Иван", "Юлия", "Максим"];
const demoStores = new Map(); // id гостя → { bookings, closed }
function demoStore(userId) {
  if (demoStores.has(userId)) return demoStores.get(userId);
  const rnd = seeded(Number(userId) || 1);
  const bookings = [];
  for (const d of nextDays(7)) {
    const slots = daySlots(d.iso);
    if (!slots.length) continue;
    let m = toMin(slots[0]) + 30 * Math.floor(rnd() * 3);
    const end = toMin(slots[slots.length - 1]) + STEP_MINUTES;
    while (m < end) {
      const s = SERVICES[Math.floor(rnd() * SERVICES.length)];
      if (m + s.minutes > end) break;
      if (rnd() < 0.55) {
        bookings.push({
          id: "demo" + bookings.length, service: s.name, minutes: s.minutes, price: s.price, day: d.iso, time: toTime(m),
          name: DEMO_NAMES[Math.floor(rnd() * DEMO_NAMES.length)], phone: `+7 900 000-${String(10 + Math.floor(rnd() * 89))}-${String(10 + Math.floor(rnd() * 89))}`,
          confirmed: rnd() < 0.5,
        });
        m += s.minutes;
      } else m += 30 * (1 + Math.floor(rnd() * 3));
    }
  }
  const store = { bookings, closed: { days: [], slots: [] } };
  demoStores.set(userId, store);
  return store;
}

// откуда брать данные: настоящие файлы или демо-хранилище гостя
function masterSource(user) {
  if (user.id === ADMIN_ID) {
    return {
      demo: false,
      bookings: () => loadBookings(),
      closed: () => loadClosed(),
      saveClosed: (c) => saveClosed(c),
      cancel: (id) => cancelByMaster(id),
    };
  }
  const st = demoStore(user.id);
  return {
    demo: true,
    bookings: () => st.bookings,
    closed: () => st.closed,
    saveClosed: (c) => { st.closed = c; },
    cancel: async (id) => { const b = st.bookings.find((x) => x.id === id); st.bookings = st.bookings.filter((x) => x !== b); return b || null; },
  };
}

// всё, что показывает кабинет: дни, выбранный день с «клеточками» времени и записями, итоги на сегодня
function masterView(src, iso) {
  const all = src.bookings();
  const closed = src.closed();
  const onDay = (d) => all.filter((b) => b.day === d).sort((a, b) => toMin(a.time) - toMin(b.time));
  const sum = (list) => list.reduce((s, b) => s + priceOf(b), 0);
  const days = nextDays(MASTER_DAYS).map((d) => {
    const c = dayCard(d.iso, 0);
    const list = onDay(d.iso);
    return { iso: d.iso, weekday: c.weekday, day: c.day, month: c.month, label: c.label, count: list.length, off: !workHours(d.iso), closed: closed.days.includes(d.iso) };
  });
  const day = iso && days.some((d) => d.iso === iso) ? iso : days[0].iso;
  const list = onDay(day);
  const covering = (t) => list.find((b) => toMin(b.time) <= toMin(t) && toMin(t) < toMin(b.time) + durOf(b));
  const today = onDay(dayAfter(0));
  return {
    demo: src.demo,
    today: { count: today.length, revenue: sum(today) },
    tomorrow: { count: onDay(dayAfter(1)).length },
    days,
    day: {
      iso: day,
      pretty: prettyDay(day),
      off: !workHours(day),
      closed: closed.days.includes(day),
      revenue: sum(list),
      slots: daySlots(day).map((t) => ({ time: t, state: covering(t) ? "booked" : closed.days.includes(day) || closed.slots.includes(`${day} ${t}`) ? "closed" : "free" })),
      bookings: list.map((b) => ({ id: b.id, range: timeRange(b), service: b.service, name: b.name, phone: b.phone || "", price: priceOf(b), confirmed: !!b.confirmed })),
    },
  };
}

Object.assign(API, {
  "POST /api/master/state": (_, body, user) => masterView(masterSource(user), body.day),
  // закрыть/открыть время
  "POST /api/master/slot": (_, body, user) => {
    const src = masterSource(user);
    const day = String(body.day), t = String(body.time);
    const c = src.closed();
    if (src.bookings().some((b) => b.day === day && toMin(b.time) <= toMin(t) && toMin(t) < toMin(b.time) + durOf(b))) return { error: "booked" };
    if (c.days.includes(day)) return { error: "dayoff" };
    const key = `${day} ${t}`;
    src.saveClosed({ ...c, slots: c.slots.includes(key) ? c.slots.filter((s) => s !== key) : [...c.slots, key] });
    return masterView(src, day);
  },
  // весь день — выходной / рабочий
  "POST /api/master/day": (_, body, user) => {
    const src = masterSource(user);
    const day = String(body.day);
    const c = src.closed();
    src.saveClosed({ ...c, days: c.days.includes(day) ? c.days.filter((d) => d !== day) : [...c.days, day] });
    return masterView(src, day);
  },
  // отменить запись клиента (клиенту придёт сообщение; в демо — только на экране)
  "POST /api/master/cancel": async (_, body, user) => {
    const src = masterSource(user);
    const b = await src.cancel(String(body.id));
    if (!b) return { error: "gone" };
    return masterView(src, b.day);
  },
});

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const WEB_DIR = path.join(__dirname, "webapp");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (code, data) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
  try {
    const handler = API[`${req.method} ${url.pathname}`];
    if (handler) {
      let body = {};
      let user = null;
      if (req.method === "POST") {
        let raw = "";
        for await (const chunk of req) { raw += chunk; if (raw.length > 10000) return json(413, { error: "big" }); }
        body = JSON.parse(raw || "{}");
        user = checkInitData(body.initData);
        if (!user) return json(401, { error: "auth" }); // открыто не из Telegram или подпись не сошлась
      }
      return json(200, await handler(url.searchParams, body, user));
    }
    // статика: страница окна и её файлы (только из папки webapp)
    const file = path.normalize(path.join(WEB_DIR, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error("Ошибка окна записи:", e.message);
    json(500, { error: "server" });
  }
});

bot.catch((err) => console.error("Ошибка:", err.message));
server.listen(WEB_PORT, "127.0.0.1", () => console.log(`Окно записи: http://127.0.0.1:${WEB_PORT}`));
if (process.env.WEB_ONLY !== "1") { // WEB_ONLY=1 — только окно, без Telegram (для проверки на своём компьютере)
  setupProfile();
  bot.start();
  tick().catch((e) => console.error("Ошибка в напоминаниях:", e.message));
  console.log("Бот запущен! Откройте его в Telegram и напишите /start");
}
