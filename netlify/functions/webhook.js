const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_PASSPHRASE = process.env.ADMIN_PASSPHRASE;
const TG_API = https://api.telegram.org/bot${BOT_TOKEN};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---------- Telegram helpers ----------

async function sendMessage(chatId, text, options = {}) {
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...options }),
  });
}

async function answerCallback(callbackQueryId, text) {
  await fetch(`${TG_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  });
}

function buildQuestionKeyboard(question) {
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  return {
    inline_keyboard: question.options.map((opt, idx) => [
      { text: ${letters[idx]}) ${opt}, callback_data: ans_${question.id}_${idx} },
    ]),
  };
}

// ---------- Session helpers ----------

async function getSession(chatId) {
  const { data } = await supabase.from('sessions').select('*').eq('chat_id', chatId).maybeSingle();
  if (data) return data;
  const fresh = { chat_id: chatId, state: 'idle', data: {} };
  await supabase.from('sessions').upsert(fresh);
  return fresh;
}

async function setSession(chatId, state, data) {
  await supabase.from('sessions').upsert({
    chat_id: chatId,
    state,
    data,
    updated_at: new Date().toISOString(),
  });
}

async function isAdmin(chatId) {
  const { data } = await supabase.from('admins').select('chat_id').eq('chat_id', chatId).maybeSingle();
  return !!data;
}

// ---------- Student flow ----------

async function startStudentFlow(chatId) {
  await setSession(chatId, 'awaiting_name', {});
  await sendMessage(chatId, 'Салом! Кириш тести учун Ф.И.Ш. ни тўлиқ киритинг:');
}

async function sendQuestionAtIndex(chatId, session) {
  const { question_ids, current } = session.data;
  if (current >= question_ids.length) {
    return finishTest(chatId, session);
  }
  const qid = question_ids[current];
  const { data: question } = await supabase.from('questions').select('*').eq('id', qid).single();
  await sendMessage(
    chatId,
    Савол ${current + 1}/${question_ids.length}:\n\n${question.question_text},
    { reply_markup: buildQuestionKeyboard(question) }
  );
}

async function finishTest(chatId, session) {
  const { full_name, phone, score, question_ids } = session.data;
  const total = question_ids.length;

  await supabase.from('attempts').insert({
    chat_id: chatId,
    full_name,
    phone,
    score,
    total,
  });

  await sendMessage(chatId, `Тест якунланди!\n\nНатижа: <b>${score}/${total}</b>`);
  await setSession(chatId, 'idle', {});

  const { data: admins } = await supabase.from('admins').select('chat_id');
  const notice = Янги натижа:\n${full_name}\nТел: ${phone}\nБалл: ${score}/${total};
  for (const admin of admins || []) {
    await sendMessage(admin.chat_id, notice);
  }
}

// ---------- Admin flow ----------

const ADD_QUESTION_INSTRUCTIONS =
  'Саволни шу форматда юборинг (бир хабарда):\n\n' +
  'Савол матни бу ерга\n' +
  'A) Вариант 1\n' +
  'B) Вариант 2\n' +
  'C) Вариант 3\n' +
  'D) Вариант 4\n' +
  'Тўғри: A';

function parseQuestionBlock(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return null;

  const answerLine = lines.find((l) => /^тўғри:|^togri:|^javob:|^правильный:/i.test(l));
  if (!answerLine) return null;

  const questionText = lines[0];
  const optionLines = lines.slice(1, lines.indexOf(answerLine));
  const options = optionLines.map((l) => l.replace(/^[A-F]\)\s*/i, '').trim());
  if (options.length < 2) return null;

  const letter = answerLine.split(':')[1]?.trim().toUpperCase();
  const correctIndex = ['A', 'B', 'C', 'D', 'E', 'F'].indexOf(letter);
  if (correctIndex === -1 || correctIndex >= options.length) return null;

  return { question_text: questionText, options, correct_index: correctIndex };
}

async function handleAdminCommand(chatId, text, username) {
  if (text === '/addquestion') {
    await setSession(chatId, 'awaiting_question_block', {});
    await sendMessage(chatId, ADD_QUESTION_INSTRUCTIONS);
    return true;
  }

  if (text === '/questions') {
    const { data: qs } = await supabase
      .from('questions')
      .select('id, question_text')
      .eq('active', true)
      .order('id');
    if (!qs || qs.length === 0) {
      await sendMessage(chatId, 'Ҳозирча саволлар йўқ.');
    } else {
      const list = qs.map((q) => `#${q.id} — ${q.question_text}`).join('\n');
      await sendMessage(chatId, `${list}\n\nЎчириш учун: /delquestion <id>`);
    }
    return true;
  }

  if (text.startsWith('/delquestion')) {
    const id = parseInt(text.split(' ')[1], 10);
    if (id) {
      await supabase.from('questions').update({ active: false }).eq('id', id);
      await sendMessage(chatId, `#${id} ўчирилди.`);
    }
    return true;
  }

  return false;
}

// ---------- Main message handling ----------

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const username = msg.from.username || '';
  const admin = await isAdmin(chatId);

  if (text.startsWith('/admin')) {
    const passphrase = text.split(' ').slice(1).join(' ');
    if (passphrase && passphrase === ADMIN_PASSPHRASE) {
      await supabase.from('admins').upsert({ chat_id: chatId, username });
      await sendMessage(chatId, 'Сиз энди админсиз. /addquestion, /questions буйруқлари мавжуд.');
    } else {
      await sendMessage(chatId, 'Парол нотўғри. Формат: /admin <парол>');
    }
    return;
  }

  if (admin) {
    const handled = await handleAdminCommand(chatId, text, username);
    if (handled) return;
  }

  const session = await getSession(chatId);

  if (text === '/start') {
    await startStudentFlow(chatId);
    return;
  }

  if (session.state === 'awaiting_name') {
    const data = { ...session.data, full_name: text };
    await setSession(chatId, 'awaiting_phone', data);
    await sendMessage(chatId, 'Телефон рақамингизни киритинг:');
    return;
  }

  if (session.state === 'awaiting_phone') {
    const { data: activeQuestions } = await supabase
      .from('questions')
      .select('id')
      .eq('active', true)
      .order('id');

    if (!activeQuestions || activeQuestions.length === 0) {
      await sendMessage(chatId, 'Ҳозирча тест саволлари қўшилмаган. Кейинроқ уриниб кўринг.');
      await setSession(chatId, 'idle', {});
      return;
    }

    const data = {
      ...session.data,
      phone: text,
      question_ids: activeQuestions.map((q) => q.id),
      current: 0,
      score: 0,
    };
    await setSession(chatId, 'in_test', data);
    const updated = await getSession(chatId);
    await sendQuestionAtIndex(chatId, updated);
    return;
  }

  if (session.state === 'awaiting_question_block' && admin) {
    const parsed = parseQuestionBlock(text);
    if (!parsed) {
      await sendMessage(chatId, 'Формат нотўғри. Қайта уриниб кўринг:\n\n' + ADD_QUESTION_INSTRUCTIONS);
      return;
    }
    await supabase.from('questions').insert(parsed);
    await setSession(chatId, 'idle', {});
    await sendMessage(chatId, `Савол қўшилди: "${parsed.question_text}"`);
    return;
  }

  if (session.state === 'idle') {
    await sendMessage(chatId, 'Тестни бошлаш учун /start буйруғини юборинг.');
  }
}

async function handleCallback(cq) {
  const chatId = cq.message.chat.id;
  const [, qidStr, idxStr] = cq.data.split('_');
  const qid = parseInt(qidStr, 10);
  const chosenIndex = parseInt(idxStr, 10);

  const session = await getSession(chatId);
  if (session.state !== 'in_test') {
    await answerCallback(cq.id, '');
    return;
  }

  const { question_ids, current } = session.data;
  if (question_ids[current] !== qid) {
    await answerCallback(cq.id, 'Бу савол аллақачон ўтилган.');
    return;
  }
  if (correctIndex === -1 || correctIndex >= options.length) return null;

  return { question_text: questionText, options, correct_index: correctIndex };
}

async function handleAdminCommand(chatId, text, username) {
  if (text === '/addquestion') {
    await setSession(chatId, 'awaiting_question_block', {});
    await sendMessage(chatId, ADD_QUESTION_INSTRUCTIONS);
    return true;
  }

  if (text === '/questions') {
    const { data: qs } = await supabase
      .from('questions')
      .select('id, question_text')
      .eq('active', true)
      .order('id');
    if (!qs || qs.length === 0) {
      await sendMessage(chatId, 'Ҳозирча саволлар йўқ.');
    } else {
      const list = qs.map((q) => `#${q.id} — ${q.question_text}`).join('\n');
      await sendMessage(chatId, `${list}\n\nЎчириш учун: /delquestion <id>`);
    }
    return true;
  }

  if (text.startsWith('/delquestion')) {
    const id = parseInt(text.split(' ')[1], 10);
    if (id) {
      await supabase.from('questions').update({ active: false }).eq('id', id);
      await sendMessage(chatId, `#${id} ўчирилди.`);
    }
    return true;
  }

  return false;
}

// ---------- Main message handling ----------

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const username = msg.from.username || '';
  const admin = await isAdmin(chatId);

  if (text.startsWith('/admin')) {
    const passphrase = text.split(' ').slice(1).join(' ');
    if (passphrase && passphrase === ADMIN_PASSPHRASE) {
      await supabase.from('admins').upsert({ chat_id: chatId, username });
      await sendMessage(chatId, 'Сиз энди админсиз. /addquestion, /questions буйруқлари мавжуд.');
    } else {
      await sendMessage(chatId, 'Парол нотўғри. Формат: /admin <парол>');
    }
    return;
  }

  if (admin) {
    const handled = await handleAdminCommand(chatId, text, username);
    if (handled) return;
  }

  const session = await getSession(chatId);

  if (text === '/start') {
    await startStudentFlow(chatId);
    return;
  }

  if (session.state === 'awaiting_name') {
    const data = { ...session.data, full_name: text };
    await setSession(chatId, 'awaiting_phone', data);
    await sendMessage(chatId, 'Телефон рақамингизни киритинг:');
    return;
  }

  if (session.state === 'awaiting_phone') {
    const { data: activeQuestions } = await supabase
      .from('questions')
      .select('id')
      .eq('active', true)
      .order('id');

    if (!activeQuestions || activeQuestions.length === 0) {
      await sendMessage(chatId, 'Ҳозирча тест саволлари қўшилмаган. Кейинроқ уриниб кўринг.');
      await setSession(chatId, 'idle', {});
      return;
    }

    const data = {
      ...session.data,
      phone: text,
      question_ids: activeQuestions.map((q) => q.id),
      current: 0,
      score: 0,
    };
    await setSession(chatId, 'in_test', data);
    const updated = await getSession(chatId);
    await sendQuestionAtIndex(chatId, updated);
    return;
  }

  if (session.state === 'awaiting_question_block' && admin) {
    const parsed = parseQuestionBlock(text);
    if (!parsed) {
      await sendMessage(chatId, 'Формат нотўғри. Қайта уриниб кўринг:\n\n' + ADD_QUESTION_INSTRUCTIONS);
      return;
    }
    await supabase.from('questions').insert(parsed);
    await setSession(chatId, 'idle', {});
    await sendMessage(chatId, `Савол қўшилди: "${parsed.question_text}"`);
    return;
  }

  if (session.state === 'idle') {
    await sendMessage(chatId, 'Тестни бошлаш учун /start буйруғини юборинг.');
  }
}

async function handleCallback(cq) {
  const chatId = cq.message.chat.id;
  const [, qidStr, idxStr] = cq.data.split('_');
  const qid = parseInt(qidStr, 10);
  const chosenIndex = parseInt(idxStr, 10);

  const session = await getSession(chatId);
  if (session.state !== 'in_test') {
    await answerCallback(cq.id, '');
    return;
  }

  const { question_ids, current } = session.data;
  if (question_ids[current] !== qid) {
    await answerCallback(cq.id, 'Бу савол аллақачон ўтилган.');
    return;
  }
