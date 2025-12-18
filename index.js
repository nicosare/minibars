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

// Функция отправки сообщения в VK
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
      'https://api.vk.com/method/messages.send?' + params.toString()
    );
    const data = await res.json();

    if (data.error) {
      console.error('VK send message error:', data.error.error_msg);
      return false;
    }

    console.log('Message sent to peer', peerId, 'response:', data.response);
    return true;
  } catch (e) {
    console.error('Failed to send VK message:', e.message);
    return false;
  }
}

// Отдельная глобальная ветка для опустошённых номеров (с timestamp):
// vkEmptiedRooms/<room>: { ts: <unix_timestamp> }
const VK_EMPTIED_ROOT = 'vkEmptiedRooms';

// Упрощенная структура "уже проверенных номеров" по дате:
// vkCheckedRoomsByDate/<YYYY-MM-DD>/<room>: { ts: <unix> }
const VK_CHECKED_ROOT = 'vkCheckedRoomsByDate';

// Set для отслеживания обработанных сообщений (peer_id + text + date)
const processedMessages = new Set();

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
        
        // Если устанавливаем статус OK (опустошение), очищаем продукты
        if (status === 'ok' || status === 'auto_ok') {
          await db.ref(`minibarData/rooms/${i}/products`).set({});
        }
        
        break;
      }
    }
  } catch (e) {
    console.error('Failed to update deadline status for room', roomNumber, e.message);
  }
}

// Получить статус и продукты номера
async function getRoomStatusAndProducts(roomNumber) {
  try {
    console.log(`Getting data for room ${roomNumber}...`);
    const snap = await db.ref('minibarData/rooms').once('value');
    const rooms = snap.val();
    console.log(`Rooms data type: ${typeof rooms}, isArray: ${Array.isArray(rooms)}`);

    if (!Array.isArray(rooms)) {
      console.log(`Rooms is not an array, value:`, rooms);
      return null;
    }

    console.log(`Searching for room ${roomNumber} in ${rooms.length} rooms...`);

    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i];
      if (!r || typeof r !== 'object') {
        console.log(`Room ${i}: invalid data`, r);
        continue;
      }

      console.log(`Room ${i}: number=${r.number}, deadlinesStatus=${r.deadlinesStatus}, has products: ${!!r.products}`);

      if (String(r.number) === String(roomNumber)) {
        console.log(`Found room ${roomNumber}! status: ${r.deadlinesStatus}, products:`, r.products);
        return {
          status: r.deadlinesStatus || null,
          products: r.products || {}
        };
      }
    }

    console.log(`Room ${roomNumber} not found in database`);
    return null;
  } catch (e) {
    console.error('Failed to get room status and products for', roomNumber, e.message);
    return null;
  }
}

// Маппинг английских названий продуктов на русские (из index.html)
const PRODUCT_NAME_MAPPING = {
  twix: 'Твикс',
  jager: 'Ягер',
  gin: 'Джин',
  rum: 'Ром',
  cognac: 'Коньяк',
  whiskey: 'Виски',
  vodka: 'Водка',
  pepper: 'Пеппер',
  redbull: 'Ред Булл',
  cola: 'Кола',
  baikal: 'Байкал',
  borjomi: 'Боржоми',
  white_wine: 'Белое вино',
  red_wine: 'Красное вино',
  apple: 'Яблоко',
  tomato: 'Томат',
  corona: 'Корона',
  stella: 'Стелла',
  gancha: 'Ганча',
  martini: 'Мартини',
  orange: 'Апельсин',
  cherry: 'Вишня',
  loriot: 'Лориот',
  whiskey02: 'Виски 0.2'
};

// Преобразовать название продукта из английского в русский
function getRussianProductName(englishName) {
  const lowerName = englishName.toLowerCase();
  return PRODUCT_NAME_MAPPING[lowerName] || englishName; // Если нет маппинга, возвращаем оригинал
}

// Сформировать сообщение о продуктах с истекающими сроками
function formatExpiryNotificationMessage(roomsWithProducts) {
  if (!roomsWithProducts || roomsWithProducts.length === 0) return null;

  const roomNumbers = roomsWithProducts.map(item => item.room);
  const roomsText = roomNumbers.length === 1 ? `номере ${roomNumbers[0]}` : `номерах ${roomNumbers.join(', ')}`;

  let message = `В ${roomsText} была продукция с истекающим сроком годности. Проверь и убери, если это так:`;

  for (const item of roomsWithProducts) {
    if (roomNumbers.length > 1) {
      message += `\n${item.room}: `;
    } else {
      message += '\n';
    }

    const products = [];
    for (const [productName, quantity] of Object.entries(item.products)) {
      if (quantity > 0) {
        const russianName = getRussianProductName(productName);
        products.push(`${russianName} x${quantity}`);
      }
    }

    if (products.length > 0) {
      message += products.join(', ');
    } else {
      message += 'нет продуктов';
    }
  }

  return message;
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

  // Создаем уникальный идентификатор сообщения (peer_id + text + date)
  // Это защитит от дублирования даже если conversation_message_id разный для message_new/message_edit
  const messageId = `${msg.peer_id}_${msg.text}_${msg.date}`;
  console.log('Checking message ID:', messageId, 'processedMessages size:', processedMessages.size);

  if (processedMessages.has(messageId)) {
    console.log('❌ Message already processed, skipping:', messageId);
    return;
  }

  console.log('✅ Processing new message:', messageId);
  // Добавляем сообщение в обработанные
  processedMessages.add(messageId);

  // Очищаем старые сообщения из Set (чтобы не рос бесконечно)
  if (processedMessages.size > 1000) {
    // Оставляем только последние 500 сообщений
    const tempSet = new Set([...processedMessages].slice(-500));
    processedMessages.clear();
    tempSet.forEach(id => processedMessages.add(id));
  }

  console.log('Message:', msg.peer_id, msg.conversation_message_id, msg.text);


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

    // Собираем номера с продуктами для уведомлений
    const roomsWithProducts = [];

    for (const room of parsed.rooms) {
      // Добавляем/обновляем в списке проверенных на сегодня
      await checkedDayRef.child(room).set({ ts: msgTs });
      
      const emptiedRef = db.ref(`${VK_EMPTIED_ROOT}/${room}`);
      
      if (parsed.emptied) {
        // Помечаем как опустошённый с timestamp (такая же логика, как для vkCheckedRoomsByDate)
        await emptiedRef.set({ ts: msgTs });

        // Проверяем статус ДО изменения на 'ok'
        const roomData = await getRoomStatusAndProducts(room);
        const hasProductsStatus = roomData && roomData.status === 'products';

        // Если статус 'products', сохраняем информацию для уведомления
        if (hasProductsStatus) {
          roomsWithProducts.push({
            room: room,
            products: roomData.products
          });
        }

        // Устанавливаем статус 'ok' ПОСЛЕ проверки
        await setDeadlineStatusForRoom(room, 'auto_ok');
        console.log(`Added room ${room} as emptied at ${msgTs}, had products status: ${hasProductsStatus}`);
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

    // Проверяем и отправляем уведомления о продуктах с истекающими сроками
    // Используем информацию, собранную в цикле выше
    if (parsed.type === 'add' && parsed.emptied && roomsWithProducts.length > 0) {
      const message = formatExpiryNotificationMessage(roomsWithProducts);
      if (message) {
        console.log('📤 Sending expiry notification to', PEER_ID, ':', message);
        const result = await sendVKMessage(PEER_ID, message);
        console.log('📤 Send result:', result ? 'SUCCESS' : 'FAILED');
      }
    }
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
    console.log('Processing message event:', upd.type, 'conversation_message_id:', msg?.conversation_message_id, 'text:', msg?.text);
    try {
      await upsertMessageRooms(msg);
    } catch (e) {
      console.error('upsertMessageRooms error:', e);
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
