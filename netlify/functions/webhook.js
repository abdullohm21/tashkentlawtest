const { createClient } = require('@supabase/supabase-js');

var BOT_TOKEN = process.env.BOT_TOKEN;
var ADMIN_PASSPHRASE = process.env.ADMIN_PASSPHRASE;
var TG_API = 'https://api.telegram.org/bot' + BOT_TOKEN;

var supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---------- Telegram helpers ----------

async function sendMessage(chatId, text, options) {
  options = options || {};
  var body = { chat_id: chatId, text: text, parse_mode: 'HTML' };
  for (var key in options) { body[key] = options[key]; }
  await fetch(TG_API + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function answerCallback(callbackQueryId, text) {
  await fetch(TG_API + '/answerCallbackQuery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text: text, show_alert: false }),
  });
}

function buildQuestionKeyboard(question) {
  var letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  var rows = [];
  for (var i = 0; i < question.options.length; i++) {
    rows.push([{
      text: letters[i] + ') ' + question.options[i],
      callback_data: 'ans_' + question.id + '_' + i,
    }]);
  }
  return { inline_keyboard: rows };
}

// ---------- Session helpers ----------

async function getSession(chatId) {
  var res = await supabase.from('sessions').select('*').eq('chat_id', chatId).maybeSingle();
  if (res.data) return res.data;
  var fresh = { chat_id: chatId, state: 'idle', data: {} };
  await supabase.from('sessions').upsert(fresh);
  return fresh;
}

async function setSession(chatId, state, data) {
  await supabase.from('sessions').upsert({
    chat_id: chatId,
    state: state,
    data: data,
    updated_at: new Date().toISOString(),
  });
}

async function isAdmin(chatId) {
  var res = await supabase.from('admins').select('chat_id').eq('chat_id', chatId).maybeSingle();
  return !!res.data;
}

// ---------- Student flow ----------

async function startStudentFlow(chatId) {
  await setSession(chatId, 'awaiting_name', {});
  await sendMessage(chatId, 'Салом! Кириш тести учун Ф.И.Ш. ни тўлиқ киритинг:');
}

async function sendQuestionAtIndex(chatId, session) {
  var questionIds = session.data.question_ids;
  var current = session.data.current;
  if (current >= questionIds.length) {
    return finishTest(chatId, session);
  }
  var qid = questionIds[current];
  var res = await supabase.from('questions').select('*').eq('id', qid).single();
  var question = res.data;
  var header = 'Савол ' + (current + 1) + '/' + questionIds.length + ':\n\n' + question.question_text;
  await sendMessage(chatId, header, { reply_markup: buildQuestionKeyboard(question) });
}

async function finishTest(chatId, session) {
  var fullName = session.data.full_name;
  var phone = session.data.phone;
  var score = session.data.score;
  var total = session.data.question_ids.length;

  await supabase.from('attempts').insert({
    chat_id: chatId,
    full_name: fullName,
    phone: phone,
    score: score,
    total: total,
  });

  await sendMessage(chatId, 'Тест якунланди!\n\nНатижа: <b>' + score + '/' + total + '</b>');
  await setSession(chatId, 'idle', {});

  var adminsRes = await supabase.from('admins').select('chat_id');
  var admins = adminsRes.data || [];
  var notice = 'Янги натижа:\n' + fullName + '\nТел: ' + phone + '\nБалл: ' + score + '/' + total;
  for (var i = 0; i < admins.length; i++) {
    await sendMessage(admins[i].chat_id, notice);
  }
}

// ---------- Admin flow ----------

var ADD_QUESTION_INSTRUCTIONS =
  'Саволни шу форматда юборинг (бир хабарда):\n\n' +
  'Савол матни бу ерга\n' +
  'A) Вариант 1\n' +
  'B) Вариант 2\n' +
  'C) Вариант 3\n' +
  'D) Вариант 4\n' +
  'Тўғри: A';

function parseQuestionBlock(text) {
  var rawLines = text.split('\n');
  var lines = [];
  for (var i = 0; i < rawLines.length; i++) {
    var t = rawLines[i].trim();
    if (t) lines.push(t);
  }
  if (lines.length < 3) return null;

  var answerLineIndex = -1;
  for (var j = 0; j < lines.length; j++) {
    if (/^тўғри:|^togri:|^javob:|^правильный:/i.test(lines[j])) {
      answerLineIndex = j;
      break;
    }
  }
  if (answerLineIndex === -1) return null;

  var questionText = lines[0];
  var optionLines = lines.slice(1, answerLineIndex);
  var options = [];
  for (var k = 0; k < optionLines.length; k++) {
    options.push(optionLines[k].replace(/^[A-F]\)\s*/i, '').trim());
  }
  if (options.length < 2) return null;

  var answerParts = lines[answerLineIndex].split(':');
  var letter = (answerParts[1] || '').trim().toUpperCase();
  var letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  var correctIndex = letters.indexOf(letter);
  if (correctIndex === -1 || correctIndex >= options.length) return null;

  return { question_text: questionText, options: options, correct_index: correctIndex };
}

async function handleAdminCommand(chatId, text) {
  if (text === '/addquestion') {
    await setSession(chatId, 'awaiting_question_block', {});
    await sendMessage(chatId, ADD_QUESTION_INSTRUCTIONS);
    return true;
  }

  if (text === '/questions') {
    var qsRes = await supabase
      .from('questions')
      .select('id, question_text')
      .eq('active', true)
      .order('id');
    var qs = qsRes.data;
    if (!qs || qs.length === 0) {
      await sendMessage(chatId, 'Ҳозирча саволлар йўқ.');
    } else {
      var lines = [];
      for (var i = 0; i < qs.length; i++) {
        lines.push('#' + qs[i].id + ' - ' + qs[i].question_text);
      }
      await sendMessage(chatId, lines.join('\n') + '\n\nЎчириш учун: /delquestion <id>');
    }
    return true;
  }

  if (text.indexOf('/delquestion') === 0) {
    var parts = text.split(' ');
    var id = parseInt(parts[1], 10);
    if (id) {
      await supabase.from('questions').update({ active: false }).eq('id', id);
      await sendMessage(chatId, '#' + id + ' ўчирилди.');
    }
    return true;
  }

  return false;
}

// ---------- Main message handling ----------

async function handleMessage(msg) {
  var chatId = msg.chat.id;
  var text = (msg.text || '').trim();
  var username = msg.from.username || '';
  var admin = await isAdmin(chatId);

  if (text.indexOf('/admin') === 0) {
    var passphrase = text.split(' ').slice(1).join(' ');
    if (passphrase && passphrase === ADMIN_PASSPHRASE) {
      await supabase.from('admins').upsert({ chat_id: chatId, username: username });
      await sendMessage(chatId, 'Сиз энди админсиз. /addquestion, /questions буйруқлари мавжуд.');
    } else {
      await sendMessage(chatId, 'Парол нотўғри. Формат: /admin <парол>');
    }
    return;
  }

  if (admin) {
    var handled = await handleAdminCommand(chatId, text);
    if (handled) return;
  }

  var session = await getSession(chatId);

  if (text === '/start') {
    await startStudentFlow(chatId);
    return;
  }

  if (session.state === 'awaiting_name') {
    var data1 = session.data;
    data1.full_name = text;
    await setSession(chatId, 'awaiting_phone', data1);
    await sendMessage(chatId, 'Телефон рақамингизни киритинг:');
    return;
  }

  if (session.state === 'awaiting_phone') {
    var activeRes = await supabase
      .from('questions')
      .select('id')
      .eq('active', true)
      .order('id');
    var activeQuestions = activeRes.data;

    if (!activeQuestions || activeQuestions.length === 0) {
      await sendMessage(chatId, 'Ҳозирча тест саволлари қўшилмаган. Кейинроқ уриниб кўринг.');
      await setSession(chatId, 'idle', {});
      return;
    }

    var ids = [];
    for (var i = 0; i < activeQuestions.length; i++) {
      ids.push(activeQuestions[i].id);
    }

    var data2 = session.data;
    data2.phone = text;
    data2.question_ids = ids;
    data2.current = 0;
    data2.score = 0;
    await setSession(chatId, 'in_test', data2);
    var updated1 = await getSession(chatId);
    await sendQuestionAtIndex(chatId, updated1);
    return;
  }

  if (session.state === 'awaiting_question_block' && admin) {
    var parsed = parseQuestionBlock(text);
    if (!parsed) {
      await sendMessage(chatId, 'Формат нотўғри. Қайта уриниб кўринг:\n\n' + ADD_QUESTION_INSTRUCTIONS);
      return;
    }
    await supabase.from('questions').insert(parsed);
    await setSession(chatId, 'idle', {});
    await sendMessage(chatId, 'Савол қўшилди: "' + parsed.question_text + '"');
    return;
  }

  if (session.state === 'idle') {
    await sendMessage(chatId, 'Тестни бошлаш учун /start буйруғини юборинг.');
  }
}

async function handleCallback(cq) {
  var chatId = cq.message.chat.id;
  var parts = cq.data.split('_');
  var qid = parseInt(parts[1], 10);
  var chosenIndex = parseInt(parts[2], 10);

  var session = await getSession(chatId);
  if (session.state !== 'in_test') {
    await answerCallback(cq.id, '');
    return;
  }

  var questionIds = session.data.question_ids;
  var current = session.data.current;
  if (questionIds[current] !== qid) {
    await answerCallback(cq.id, 'Бу савол аллақачон ўтилган.');
    return;
  }

  var qRes = await supabase.from('questions').select('*').eq('id', qid).single();
  var question = qRes.data;
  var correct = chosenIndex === question.correct_index;
  await answerCallback(cq.id, correct ? 'Тўғри!' : 'Нотўғри');

  var newData = session.data;
  newData.current = current + 1;
  newData.score = session.data.score + (correct ? 1 : 0);
  await setSession(chatId, 'in_test', newData);
  var updated2 = await getSession(chatId);
  await sendQuestionAtIndex(chatId, updated2);
}

// ---------- Entry point ----------

exports.handler = async function (event) {
  try {
    var update = JSON.parse(event.body || '{}');
    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update.message) {
      await handleMessage(update.message);
    }
  } catch (err) {
    console.error(err);
  }
  return { statusCode: 200, body: 'ok' };
};
