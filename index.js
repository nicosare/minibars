const express = require('express');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// === VK настройки ===
const VK_BOT_TOKEN = process.env.VK_BOT_TOKEN;
const VK_GROUP_ID = Number(process.env.VK_GROUP_ID || '234416204');
// peer_id вашей беседы
const PEER_ID = 2000000001;

if (!VK_BOT_TOKEN) {
  console.error('VK_BOT_TOKEN не задан. Укажите токен бота в переменной окружения.');
  process.exit(1);
}

// === Firebase ===
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('FIREBASE_SERVICE_ACCOUNT не задан.');
  process.exit(1);
}
if (!process.env.FIREBASE_DATABASE_URL) {
  console.error('FIREBASE_DATABASE_URL не задан.');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();

// Отдельная глобальная ветка для опустошённых номеров (с timestamp):
// vkEmptiedRooms/<room>: { ts: <unix_timestamp> }
const VK_EMPTIED_ROOT = 'vkEmptiedRooms';

// Упрощенная структура "уже проверенных номеров" по дате:
// vkCheckedRoomsByDate/<YYYY-MM-DD>/<room>: { ts: <unix> }
const VK_CHECKED_ROOT = 'vkCheckedRoomsByDate';

// Хранение ID отправленных ботом сообщений для возможности удаления
// Формат: { peerId: { messageId: true } }
const sentMessages = {};

// Обновление статуса сроков для номера в ветке minibarData/rooms
async function setDeadlineStatusForRoom(roomNumber, status) {
  try {
    const snap = await db.ref('minibarData/rooms').once('value');
    const rooms = snap.val();
    if (!Array.isArray(rooms)) return;

    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i];
      if (!r || typeof r !== 'object') continue;
      if (String(r.number) === String(roomNumber)) {
        // Устанавливаем статус
        await db.ref(`minibarData/rooms/${i}/deadlinesStatus`).set(status);

        // Если устанавливаем статус 'ok' (опустошение), очищаем продукты
        if (status === 'ok') {
          await db.ref(`minibarData/rooms/${i}/products`).set({});
        }

        break;
      }
    }
  } catch (e) {
    console.error('Failed to update deadline status for room', roomNumber, e.message);
  }
}

// Получение статуса и продуктов для номера из ветки minibarData/rooms
async function getRoomDeadlineInfo(roomNumber) {
  try {
    const snap = await db.ref('minibarData/rooms').once('value');
    const rooms = snap.val();
    if (!Array.isArray(rooms)) return null;

    for (const r of rooms) {
      if (!r || typeof r !== 'object') continue;
      if (String(r.number) === String(roomNumber)) {
        return {
          deadlinesStatus: r.deadlinesStatus,
          products: r.products || {}
        };
      }
    }
    return null;
  } catch (e) {
    console.error('Failed to get room deadline info for', roomNumber, e.message);
    return null;
  }
}

// Екатеринбург: UTC+5 → 5 * 60 минут
const TZ_OFFSET_MINUTES = 5 * 60;

// Список допустимых номеров
const ALLOWED_ROOMS = [
  '500', '502', '504', '506', '508', '509', '510', '512', '514', '516', '518', '520', '522', '524', '526', '528',
  '530', '532', '534', '600', '602', '604', '606', '608', '609', '610', '612', '614', '616', '618', '620', '622',
  '624', '626', '628', '630', '632', '634', '700', '702', '704', '706', '708', '709', '710', '712', '714', '716',
  '717', '718', '720', '722', '724', '725', '726', '728', '730', '732', '734', '800', '802', '804', '806', '808',
  '809', '810', '812', '814', '816', '817', '818', '820', '822', '824', '825', '826', '828', '830', '832', '834',
  '900', '902', '904', '906', '908', '909', '910', '912', '914', '916', '917', '918', '920', '922', '924', '925',
  '926', '928', '930', '932', '934', '1000', '1002', '1004', '1006', '1008', '1009', '1010', '1012', '1014', '1016',
  '1017', '1018', '1020', '1022', '1024', '1025', '1026', '1028', '1030', '1032', '1034', '1100', '1102', '1104',
  '1106', '1108', '1109', '1110', '1112', '1114', '1116', '1117', '1118', '1120', '1122', '1124', '1125', '1126',
  '1128', '1130', '1132', '1134', '1200', '1202', '1204', '1206', '1208', '1209', '1210', '1212', '1214', '1216',
  '1217', '1218', '1220', '1222', '1224', '1225', '1226', '1228', '1230', '1232', '1234', '1300', '1302', '1304',
  '1306', '1308', '1309', '1310', '1312', '1314', '1316', '1317', '1318', '1320', '1322', '1324', '1325', '1326',
  '1328', '1330', '1332', '1334', '1400', '1402', '1404', '1406', '1408', '1409', '1410', '1412', '1414', '1416',
  '1417', '1418', '1420', '1422', '1424', '1425', '1426', '1428', '1430', '1432', '1434', '1500', '1502', '1504',
  '1506', '1508', '1509', '1510', '1512', '1514', '1516', '1517', '1518', '1520', '1522', '1524', '1525', '1526',
  '1528', '1530', '1532', '1534', '1600', '1602', '1604', '1606', '1608', '1609', '1610', '1612', '1614', '1616',
  '1617', '1618', '1620', '1622', '1624', '1625', '1626', '1628', '1630', '1632', '1634', '1700', '1702', '1704',
  '1706', '1708', '1709', '1710', '1712', '1714', '1716', '1717', '1718', '1720', '1722', '1724', '1725', '1726',
  '1728', '1730', '1732', '1734', '1800', '1802', '1804', '1806', '1807', '1808', '1810', '1811', '1812', '1814',
  '1816', '1818', '1902', '1904', '1906', '1908', '1910', '1911', '1912', '1914', '1916', '1918', '1919', '1920'
];

const ALLOWED_SET = new Set(ALLOWED_ROOMS);

// Маппинг продуктов на русские названия
const PRODUCT_NAMES = {
    twix: 'Твикс', jager: 'Ягер', gin: 'Джин', rum: 'Ром', cognac: 'Коньяк',
    whiskey: 'Виски', vodka: 'Водка', pepper: 'Пеппер', redbull: 'Ред Булл',
    cola: 'Кола', baikal: 'Байкал', borjomi: 'Боржоми', white_wine: 'Белое вино',
    red_wine: 'Красное вино', apple: 'Яблоко', tomato: 'Томат', corona: 'Корона',
    stella: 'Стелла', gancha: 'Ганча', martini: 'Мартини', orange: 'Апельсин',
    cherry: 'Вишня', loriot: 'Лориот', whiskey02: 'Виски 0.2'
};

// === утилиты времени (UTC+5, Екатеринбург) ===
function localDateFromUnix(tsSec) {
  const offsetMs = TZ_OFFSET_MINUTES * 60 * 1000;
  return new Date(tsSec * 1000 + offsetMs);
}

function dateKeyFromUnix(tsSec) {
  const d = localDateFromUnix(tsSec);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayKey() {
  const offsetMs = TZ_OFFSET_MINUTES * 60 * 1000;
  const d = new Date(Date.now() + offsetMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function timeStringFromUnix(tsSec) {
  const d = localDateFromUnix(tsSec);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// Новая логика парсинга сообщений
function parseMessage(text) {
  if (!text || typeof text !== 'string') return null;
  
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  
  // Проверяем, начинается ли сообщение с "-"
  if (trimmed.startsWith('-')) {
    // Удаление - более строгая проверка
    const withoutMinus = trimmed.slice(1).trim();
    if (withoutMinus.length === 0) return null;
    
    // Ищем все номера
    const roomMatches = withoutMinus.match(/\d{3,4}/g) || [];
    const validRooms = roomMatches.filter(room => ALLOWED_SET.has(room));
    
    if (validRooms.length === 0) return null;
    
    // Для удаления: проверяем, что после удаления всех номеров и разделителей ничего не осталось
    // Разрешаем только номера и разделители (пробелы, запятые, точки, тире)
    const textWithoutRooms = withoutMinus.replace(/\d{3,4}/g, '').replace(/[\s,\-\.;:!?]/g, '');
    if (textWithoutRooms.length > 0) {
      // Есть посторонние символы/слова - игнорируем
      return null;
    }
    
    return { type: 'delete', rooms: validRooms };
  }
  
  // Ищем первое число в сообщении
  const firstMatch = trimmed.match(/^\d{3,4}/);
  if (!firstMatch) return null;
  
  const firstRoom = firstMatch[0];
  if (!ALLOWED_SET.has(firstRoom)) return null;
  
  // Находим все номера в сообщении
  const roomMatches = trimmed.match(/\d{3,4}/g) || [];
  const validRooms = roomMatches.filter(room => ALLOWED_SET.has(room));
  
  if (validRooms.length === 0) return null;
  
  // Проверяем, что нет слов между номерами
  // Для этого проверяем часть текста до последнего номера
  const lastRoom = validRooms[validRooms.length - 1];
  const lastIndex = trimmed.lastIndexOf(lastRoom) + lastRoom.length;
  
  // Текст до последнего номера (включая разделители)
  const beforeLastRoom = trimmed.slice(0, lastIndex);
  
  // Удаляем все номера и разрешенные разделители
  const beforeCleaned = beforeLastRoom.replace(/\d{3,4}/g, '').replace(/[\s,\-\.;:!?]/g, '');
  if (beforeCleaned.length > 0) {
    // Есть слова между номерами - игнорируем
    return null;
  }
  
  // Текст после последнего номера
  const afterLastRoom = trimmed.slice(lastIndex).trim().toLowerCase();
  
  // Проверяем, есть ли "опустош" после последнего номера
  // Ищем "опустош" в любом месте после номеров
  const опустошIndex = afterLastRoom.indexOf('опустош');
  const hasEmptyMark = опустошIndex !== -1;
  
  // Для добавления: если есть слово "опустош", то помечаем как опустошённый
  // Не важно, что после "опустош" (могут быть другие слова)
  return { type: 'add', rooms: validRooms, emptied: hasEmptyMark };
}

// === обработка (нового или отредактированного) сообщения ===
async function upsertMessageRooms(msg) {
  if (!msg) return;

  console.log('Processing message:', msg.peer_id, msg.conversation_message_id, msg.text);


  const text = msg.text || '';
  
  // Парсим сообщение
  const parsed = parseMessage(text);
  if (!parsed) {
    console.log('Message ignored - not a valid command:', text);
    return;
  }

  const msgTs = msg.date || Math.floor(Date.now() / 1000);
  const key = dateKeyFromUnix(msgTs);

  if (parsed.type === 'delete') {
    // Удаление номеров
    const checkedDayRef = db.ref(`${VK_CHECKED_ROOT}/${key}`);
    
    for (const room of parsed.rooms) {
      // Проверяем, есть ли номер в checked (на сегодня)
      const roomInCheckedSnap = await checkedDayRef.child(room).once('value');
      const isInChecked = roomInCheckedSnap.exists();
      
      if (isInChecked) {
        // Удаляем из списка проверенных на сегодня
        await checkedDayRef.child(room).remove();
        
        // Удаляем из списка опустошённых (только если был в checked)
        const emptiedRef = db.ref(`${VK_EMPTIED_ROOT}/${room}`);
        await emptiedRef.remove();
        
        console.log(`Deleted room ${room} from checked and emptied (was in checked)`);
      } else {
        console.log(`Room ${room} not in checked, skipping deletion`);
      }
    }
  } else {
    // Добавление номеров
    const checkedDayRef = db.ref(`${VK_CHECKED_ROOT}/${key}`);
    
    for (const room of parsed.rooms) {
      // Добавляем/обновляем в списке проверенных на сегодня
      await checkedDayRef.child(room).set({ ts: msgTs });
      
      const emptiedRef = db.ref(`${VK_EMPTIED_ROOT}/${room}`);
      
      if (parsed.emptied) {
        // Помечаем как опустошённый с timestamp (такая же логика, как для vkCheckedRoomsByDate)
        await emptiedRef.set({ ts: msgTs });

        // Проверяем статус номера перед опустошением
        const roomInfo = await getRoomDeadlineInfo(room);
        if (roomInfo && roomInfo.deadlinesStatus === 'products') {
          // Получаем список продуктов с учётом количества
          const productCounts = {};
          const roomProducts = roomInfo.products || {};

          // Группируем продукты по названиям
          Object.keys(roomProducts).forEach(key => {
            const count = roomProducts[key];
            if (count && count > 0) {
              const name = PRODUCT_NAMES[key] || key; // Используем русское название или ключ, если не найдено
              productCounts[name] = (productCounts[name] || 0) + count;
            }
          });

          // Формируем строку продуктов
          const productStrings = Object.keys(productCounts).map(name => {
            const count = productCounts[name];
            return count > 1 ? `${name} x${count}` : name;
          });

          if (productStrings.length > 0) {
            // Отправляем сообщение в беседу PEER_ID = 2000000001
            const message = `В номере ${room} была продукция с истекающим сроком годности. Проверь и убери, если это так: ${productStrings.join(', ')}`;
            const messageId = await sendVKMessage(PEER_ID, message);
            console.log('Sent message with ID:', messageId, 'to peer:', PEER_ID);
            if (messageId) {
              // Сохраняем ID сообщения для возможности удаления
              if (!sentMessages[PEER_ID]) {
                sentMessages[PEER_ID] = {};
              }
              sentMessages[PEER_ID][messageId] = true;
              console.log('Saved message ID in sentMessages:', JSON.stringify(sentMessages));
            }
          }
        }

        await setDeadlineStatusForRoom(room, 'ok');
        console.log(`Added room ${room} as emptied at ${msgTs}`);
      } else {
        // Проверяем, был ли номер ранее в списке опустошённых
        const snap = await emptiedRef.once('value');
        const wasEmptied = snap.exists();
        
        // Убираем из списка опустошённых (если был)
        await emptiedRef.remove();
        
        // Если был опустошён ранее, а теперь пришёл без пометки, сбрасываем статус
        if (wasEmptied) {
          await setDeadlineStatusForRoom(room, 'neutral');
          console.log(`Added room ${room} without emptied mark, reset status from emptied`);
        } else {
          console.log(`Added room ${room} without emptied mark`);
        }
      }
    }
  }
}

// === VK API функции ===

// Функция для отправки сообщения в VK
async function sendVKMessage(peerId, message) {
  try {
    const params = new URLSearchParams({
      peer_id: peerId.toString(),
      message: message,
      access_token: VK_BOT_TOKEN,
      v: '5.199',
      random_id: Math.floor(Math.random() * 1000000)
    });

    const res = await fetch(
      'https://api.vk.com/method/messages.send?' + params.toString(),
      { method: 'POST' }
    );
    const data = await res.json();

    if (data.error) {
      console.error('VK send message error:', data.error.error_msg);
      return false;
    }

    console.log('Message sent successfully to peer', peerId, 'full response:', JSON.stringify(data));
    // Возвращаем ID отправленного сообщения для возможности удаления
    // Для бесед используем conversation_message_id если доступен
    return data.response;
  } catch (e) {
    console.error('Failed to send VK message:', e.message);
    return false;
  }
}

// Функция для удаления сообщения в VK
async function deleteVKMessage(peerId, messageId) {
  try {
    const params = new URLSearchParams({
      peer_id: peerId.toString(),
      message_ids: messageId.toString(),
      delete_for_all: '1', // Удалить для всех
      access_token: VK_BOT_TOKEN,
      v: '5.199'
    });

    const res = await fetch(
      'https://api.vk.com/method/messages.delete?' + params.toString(),
      { method: 'POST' }
    );
    const data = await res.json();

    if (data.error) {
      console.error('VK delete message error:', data.error.error_msg);
      return false;
    }

    console.log('Message deleted successfully, peer:', peerId, 'message_id:', messageId);
    return true;
  } catch (e) {
    console.error('Failed to delete VK message:', e.message);
    return false;
  }
}

// === Bots Long Poll API ===

async function getLongPollServer() {
  const params = new URLSearchParams({
    group_id: VK_GROUP_ID.toString(),
    access_token: VK_BOT_TOKEN,
    v: '5.199'
  });

  const res = await fetch(
    'https://api.vk.com/method/groups.getLongPollServer?' + params.toString()
  );
  const data = await res.json();

  if (data.error) {
    throw new Error('VK groups.getLongPollServer error: ' + data.error.error_msg);
  }

  return data.response; // { server, key, ts }
}

async function startLongPoll() {
  console.log('Starting VK Long Poll...');

  while (true) {
    try {
      const { server, key, ts } = await getLongPollServer();
      console.log('Long Poll server obtained');

      let tsCur = ts;

      while (true) {
        const baseUrl = server.startsWith('http') ? server : 'https://' + server;

const lpURL =
  baseUrl +
  '?' +
  new URLSearchParams({
    act: 'a_check',
    key,
    ts: String(tsCur),
    wait: '25',
    mode: '2',
    version: '3'
  }).toString();

        const res = await fetch(lpURL);
        const data = await res.json();

        if (data.failed) {
          // см. доку VK Bots Long Poll API
          if (data.failed === 1 && data.ts) {
            tsCur = data.ts;
            continue;
          }
          // 2 или 3 → нужно заново получить ключ/сервер
          console.warn('Long Poll failed, need new server/key:', data);
          break;
        }

        tsCur = data.ts;
        
// ЛОГИРУЕМ ВСЕ ОБНОВЛЕНИЯ ДЛЯ ОТЛАДКИ
const updates = data.updates || [];

for (const upd of updates) {
  // Логируем абсолютно все апдейты как есть
  console.log('VK update RAW:', JSON.stringify(upd));

  // Дополнительно выведем только тип и peer_id, если есть
  if (upd.object && (upd.object.message || upd.object)) {
    const m = upd.object.message || upd.object;
    console.log('VK update TYPE:', upd.type, 'PEER_ID:', m.peer_id, 'TEXT:', m.text);
  }

  if (upd.type === 'message_new' || upd.type === 'message_edit') {
    const msg = upd.object && (upd.object.message || upd.object);
    try {
      await upsertMessageRooms(msg);
    } catch (e) {
      console.error('upsertMessageRooms error:', e);
    }
  }

  // Обработка реакции на сообщение (добавление/удаление)
  if (upd.type === 'message_reaction_event') {
    const reaction = upd.object;
    console.log('Processing reaction event:', JSON.stringify(reaction));
    if (reaction && reaction.peer_id && reaction.cmid) {
      const peerId = reaction.peer_id;
      const messageId = reaction.cmid; // conversation message id

      console.log('Checking sent messages for peer', peerId, 'message', messageId);
      console.log('Available sent messages:', JSON.stringify(sentMessages));

      // Проверяем, является ли это реакцией на наше сообщение
      if (sentMessages[peerId] && sentMessages[peerId][messageId]) {
        console.log('Reaction added to our message, deleting it:', messageId);
        try {
          await deleteVKMessage(peerId, messageId);
          // Удаляем из списка отправленных сообщений
          delete sentMessages[peerId][messageId];
        } catch (e) {
          console.error('Failed to delete message after reaction:', e);
        }
      } else {
        console.log('Message not found in sent messages');
      }
    }
  }
}
      }

      // Цикл по серверу вышел → запрашиваем новый сервер
      console.log('Restarting Long Poll server...');
    } catch (e) {
      console.error('Long Poll error:', e.message);
      // подождём и попробуем снова
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// === HTTP маршруты ===

// health-check
app.get('/', (req, res) => {
  res.send('OK');
});

// Миграция: обновление старых записей с true на формат { ts: timestamp }
async function migrateEmptiedRooms() {
  try {
    const snap = await db.ref(VK_EMPTIED_ROOT).once('value');
    const data = snap.val() || {};
    const updates = {};
    let migratedCount = 0;
    
    // Получаем все даты из vkCheckedRoomsByDate для поиска timestamp
    const checkedSnap = await db.ref(VK_CHECKED_ROOT).once('value');
    const checkedData = checkedSnap.val() || {};
    
    for (const [room, roomData] of Object.entries(data)) {
      // Если запись в старом формате (true), обновляем на новый формат
      if (roomData === true || roomData === 'true') {
        let ts = null;
        
        // Пытаемся найти timestamp из vkCheckedRoomsByDate
        for (const [dateKey, dateData] of Object.entries(checkedData)) {
          if (dateData && typeof dateData === 'object' && dateData[room]) {
            const roomEntry = dateData[room];
            if (roomEntry && typeof roomEntry === 'object' && typeof roomEntry.ts === 'number') {
              ts = roomEntry.ts;
              break;
            }
          }
        }
        
        // Если не нашли в истории проверок, используем текущее время
        if (!ts) {
          ts = Math.floor(Date.now() / 1000);
        }
        
        updates[room] = { ts };
        migratedCount++;
        console.log(`Migrating room ${room} from true to { ts: ${ts} }`);
      }
    }
    
    if (migratedCount > 0) {
      await db.ref(VK_EMPTIED_ROOT).update(updates);
      console.log(`Migration completed: ${migratedCount} rooms migrated`);
    } else {
      console.log('No rooms to migrate');
    }
  } catch (e) {
    console.error('Migration error:', e.message);
  }
}

// Глобальный список опустошённых номеров (с timestamp)
app.get('/emptied-rooms', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const snap = await db.ref(VK_EMPTIED_ROOT).once('value');
    const data = snap.val() || {};
    const rooms = Object.keys(data).map(room => {
      const roomData = data[room];
      // Поддержка старого формата (true) и нового формата ({ ts: ... })
      const ts = typeof roomData === 'object' && roomData !== null && typeof roomData.ts === 'number' 
        ? roomData.ts 
        : null;
      return { room, ts };
    });
    res.json({ rooms });
  } catch (e) {
    console.error('Firebase read error (emptied-rooms):', e.message);
    res.status(500).json({
      error: 'DB_ERROR',
      message: e.message
    });
  }
});

// Номера за сегодня с временем
app.get('/today-rooms', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const key = todayKey();

  try {
    // Читаем упрощенную структуру проверенных номеров на сегодня
    const checkedSnap = await db.ref(`${VK_CHECKED_ROOT}/${key}`).once('value');
    const checkedData = checkedSnap.val() || {};

    // Для каждого номера храним объект { ts },
    // где ts — время (последнего) появления номера в списке проверенных.
    const roomToInfo = new Map();
    for (const [room, entry] of Object.entries(checkedData)) {
      if (!entry) continue;
      const ts = typeof entry.ts === 'number' ? entry.ts : 0;
      roomToInfo.set(room, { ts });
    }

    // Читаем глобальный список опустошённых номеров
    let emptiedGlobal = {};
    try {
      const emptiedSnap = await db.ref(VK_EMPTIED_ROOT).once('value');
      emptiedGlobal = emptiedSnap.val() || {};
    } catch (e) {
      console.error('Firebase read error (emptied list):', e.message);
    }

    const rooms = Array.from(roomToInfo.entries())
      .map(([room, info]) => {
        const globallyEmptied =
          emptiedGlobal && Object.prototype.hasOwnProperty.call(emptiedGlobal, room);
        return {
          room,
          time: timeStringFromUnix(info.ts),
          // Источником правды для опустошения является только глобальный список.
          emptied: !!globallyEmptied
        };
      })
      .sort((a, b) => Number(a.room) - Number(b.room));

    res.json({ rooms });
  } catch (e) {
    console.error('Firebase read error:', e.message);
    res.status(500).json({
      error: 'DB_ERROR',
      message: e.message
    });
  }
});

// Endpoint для запуска миграции вручную
app.post('/migrate-emptied-rooms', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    await migrateEmptiedRooms();
    res.json({ success: true, message: 'Migration completed' });
  } catch (e) {
    console.error('Migration endpoint error:', e.message);
    res.status(500).json({
      error: 'MIGRATION_ERROR',
      message: e.message
    });
  }
});

// стартуем HTTP и Long Poll
app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
  
  // Запускаем миграцию при старте сервера
  migrateEmptiedRooms().catch(err => {
    console.error('Failed to run migration:', err);
  });
  
  startLongPoll().catch(err => {
    console.error('Failed to start Long Poll:', err);
  });
});
