var Clay = require('@rebble/clay');
var messageKeys = require('message_keys');
var clayConfig = require('./config');
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
var OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
var BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
var TIMELINE_URL = 'https://timeline-api.getpebble.com/v1/user/pins/';
var DEFAULT_MODEL = 'moonshotai/kimi-k2.5';
var RESPONSE_CHUNK_CHARS = 700;
var MAX_SEARCH_RESULTS = 3;
var MAX_NOTES = 30;
var MAX_NOTE_CHARS = 240;

var history = [];
var sendQueue = [];
var sending = false;
var activeRequests = [];
var requestGeneration = 0;

function debugLog(message) {
  var line = new Date().toISOString() + ' ' + message;
  console.log(line);
  var existing = localStorage.getItem('DebugLog') || '';
  var combined = existing ? existing + ' | ' + line : line;
  var maxLength = 3500;
  if (combined.length > maxLength) {
    combined = combined.substring(combined.length - maxLength);
    var firstSeparator = combined.indexOf(' | ');
    if (firstSeparator !== -1) {
      combined = combined.substring(firstSeparator + 3);
    }
  }
  localStorage.setItem('DebugLog', combined);
}

function trackRequest(request, generation) {
  request._generation = generation;
  request._cancelled = false;
  activeRequests.push(request);
}

function untrackRequest(request) {
  for (var i = activeRequests.length - 1; i >= 0; i--) {
    if (activeRequests[i] === request) {
      activeRequests.splice(i, 1);
    }
  }
}

function requestIsCurrent(request) {
  return !request._cancelled && request._generation === requestGeneration;
}

function cancelActiveRequests() {
  debugLog('cancelActiveRequests active=' + activeRequests.length + ' generation=' + requestGeneration);
  requestGeneration++;
  for (var i = 0; i < activeRequests.length; i++) {
    activeRequests[i]._cancelled = true;
    try {
      activeRequests[i].abort();
    } catch (err) {
      console.log('Abort failed: ' + err.message);
    }
  }
  activeRequests = [];
  sendToWatch({ Status: 'Cancelled' });
}

function sendToWatch(dict) {
  sendQueue.push(dict);
  pumpSendQueue();
}

function showError(userMessage, detail) {
  if (detail) {
    debugLog('ERROR ' + userMessage + ': ' + detail);
  } else {
    debugLog('ERROR ' + userMessage);
  }
  sendToWatch({ Error: userMessage });
}

function pumpSendQueue() {
  if (sending || sendQueue.length === 0) {
    return;
  }

  sending = true;
  Pebble.sendAppMessage(sendQueue[0], function() {
    sendQueue.shift();
    sending = false;
    pumpSendQueue();
  }, function(e) {
    console.log('sendAppMessage failed: ' + JSON.stringify(e));
    sending = false;
    setTimeout(pumpSendQueue, 1000);
  });
}

function clip(text, maxLength) {
  text = String(text || '');
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength);
}

function sendAssistantReply(reply) {
  reply = String(reply || 'No response.');
  var chunks = [];
  for (var offset = 0; offset < reply.length; offset += RESPONSE_CHUNK_CHARS) {
    chunks.push(reply.substring(offset, offset + RESPONSE_CHUNK_CHARS));
  }
  if (chunks.length === 0) {
    chunks.push('No response.');
  }

  for (var i = 0; i < chunks.length; i++) {
    sendToWatch({
      Status: i === chunks.length - 1 ? 'Done' : 'Receiving...',
      AssistantResponse: chunks[i],
      ResponseChunkIndex: i,
      ResponseChunkDone: i === chunks.length - 1 ? 1 : 0
    });
  }
}

function getSetting(key, fallback) {
  var value = localStorage.getItem(key);
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  return value;
}

function getBoolSetting(key, fallback) {
  var value = getSetting(key, fallback ? '1' : '0');
  return value === true || value === 1 || value === '1' || value === 'true';
}

function statsMonthKey() {
  var now = new Date();
  return now.getUTCFullYear() + '-' + ('0' + (now.getUTCMonth() + 1)).slice(-2);
}

function defaultMonthlyStats() {
  return {
    month: statsMonthKey(),
    messages: 0,
    searches: 0,
    usageCredits: 0,
    remainingCredits: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  };
}

function getMonthlyStats() {
  var currentMonth = statsMonthKey();
  try {
    var stats = JSON.parse(localStorage.getItem('MonthlyStats') || '{}');
    if (stats.month === currentMonth) {
      return stats;
    }
  } catch (err) {
  }
  return defaultMonthlyStats();
}

function saveMonthlyStats(stats) {
  localStorage.setItem('MonthlyStats', JSON.stringify(stats));
}

function addUsageStats(usage) {
  if (!usage) {
    return;
  }

  var stats = getMonthlyStats();
  stats.usageCredits += Number(usage.cost || 0);
  stats.promptTokens += Number(usage.prompt_tokens || 0);
  stats.completionTokens += Number(usage.completion_tokens || 0);
  stats.totalTokens += Number(usage.total_tokens || 0);
  saveMonthlyStats(stats);
  refreshRemainingCredits();
}

function incrementStat(key) {
  var stats = getMonthlyStats();
  stats[key] = Number(stats[key] || 0) + 1;
  saveMonthlyStats(stats);
}

function formatCredits(value) {
  value = Number(value || 0);
  if (value < 0.01) {
    return value.toFixed(4);
  }
  return value.toFixed(2);
}

function buildStatsText() {
  var stats = getMonthlyStats();
  var model = getSetting('OpenRouterModel', DEFAULT_MODEL);
  var remaining = stats.remainingCredits === null || stats.remainingCredits === undefined ? 'unavailable' : formatCredits(stats.remainingCredits);
  return [
    'Used: ' + formatCredits(stats.usageCredits),
    'Remaining: ' + remaining,
    'Messages: ' + Number(stats.messages || 0),
    'Searches: ' + Number(stats.searches || 0),
    'Location: ' + (getBoolSetting('EnableLocation', false) ? 'on' : 'off'),
    'Memory: ' + (getBoolSetting('EnableMemory', true) ? 'on' : 'off'),
    'Search: ' + (getBoolSetting('EnableSearch', false) ? 'on' : 'off'),
    model
  ].join('\n');
}

function sendStatsToWatch() {
  sendToWatch({ StatsText: buildStatsText() });
}

function refreshRemainingCredits() {
  var apiKey = getSetting('OpenRouterApiKey', '');
  if (!apiKey) {
    sendStatsToWatch();
    return;
  }

  var request = new XMLHttpRequest();
  request.open('GET', OPENROUTER_CREDITS_URL, true);
  request.setRequestHeader('Authorization', 'Bearer ' + apiKey);
  request.timeout = 15000;

  request.onload = function() {
    if (request.status < 200 || request.status >= 300) {
      console.log('Credits unavailable: HTTP ' + request.status + ' ' + request.responseText);
      sendStatsToWatch();
      return;
    }

    try {
      var json = JSON.parse(request.responseText);
      if (json.data) {
        var totalCredits = Number(json.data.total_credits || 0);
        var totalUsage = Number(json.data.total_usage || 0);
        var stats = getMonthlyStats();
        stats.remainingCredits = totalCredits - totalUsage;
        saveMonthlyStats(stats);
        sendStatsToWatch();
      }
    } catch (err) {
      console.log('Credits parse failed: ' + err.message);
    }
  };

  request.onerror = function() {
    debugLog('Credits network error');
    sendStatsToWatch();
  };

  request.ontimeout = function() {
    debugLog('Credits request timed out');
    sendStatsToWatch();
  };

  request.send();
}

function setBoolSetting(key, value) {
  localStorage.setItem(key, value ? '1' : '0');
}

function toggleBoolSetting(key, fallback) {
  var value = !getBoolSetting(key, fallback);
  setBoolSetting(key, value);
  return value;
}

function getNotes() {
  try {
    var notes = JSON.parse(localStorage.getItem('NotesMemory') || '[]');
    return notes && notes.length !== undefined ? notes : [];
  } catch (err) {
    return [];
  }
}

function saveNotes(notes) {
  localStorage.setItem('NotesMemory', JSON.stringify(notes.slice(Math.max(0, notes.length - MAX_NOTES))));
}

function notesToText() {
  var notes = getNotes();
  var lines = [];
  for (var i = 0; i < notes.length; i++) {
    lines.push(notes[i].text || '');
  }
  return lines.join('\n');
}

function saveNotesFromText(text) {
  var rawLines = String(text || '').split('\n');
  var notes = [];
  for (var i = 0; i < rawLines.length; i++) {
    var note = clip(rawLines[i], MAX_NOTE_CHARS).replace(/^\s+|\s+$/g, '');
    if (note) {
      notes.push({ text: note, createdAt: new Date().toISOString() });
    }
  }
  saveNotes(notes);
}

function addNotes(notesToAdd) {
  if (!notesToAdd) {
    return;
  }

  if (!(notesToAdd instanceof Array)) {
    notesToAdd = [notesToAdd];
  }

  var notes = getNotes();
  for (var i = 0; i < notesToAdd.length; i++) {
    var text = clip(notesToAdd[i], MAX_NOTE_CHARS).replace(/^\s+|\s+$/g, '');
    if (text) {
      notes.push({ text: text, createdAt: new Date().toISOString() });
    }
  }
  saveNotes(notes);
}

function buildNotesContext() {
  if (!getBoolSetting('EnableMemory', true)) {
    return 'Persistent notes/memory disabled.';
  }

  var notes = getNotes();
  if (notes.length === 0) {
    return 'Persistent notes/memory: none yet.';
  }

  var lines = ['Persistent notes/memory available to you:'];
  for (var i = 0; i < notes.length; i++) {
    lines.push((i + 1) + '. ' + notes[i].text);
  }
  return lines.join('\n');
}

function settingValue(convertedSettings, rawSettings, name, numericKey) {
  if (rawSettings && rawSettings[name] !== undefined) {
    return rawSettings[name] && rawSettings[name].value !== undefined ? rawSettings[name].value : rawSettings[name];
  }
  if (convertedSettings && convertedSettings[name] !== undefined) {
    return convertedSettings[name];
  }
  if (convertedSettings && numericKey !== undefined && convertedSettings[numericKey] !== undefined) {
    return convertedSettings[numericKey];
  }
  return undefined;
}

function saveSettings(convertedSettings, rawSettings) {
  var apiKey = settingValue(convertedSettings, rawSettings, 'OpenRouterApiKey', messageKeys.OpenRouterApiKey);
  var model = settingValue(convertedSettings, rawSettings, 'OpenRouterModel', messageKeys.OpenRouterModel);
  var enableLocation = settingValue(convertedSettings, rawSettings, 'EnableLocation', messageKeys.EnableLocation);
  var enableMemory = settingValue(convertedSettings, rawSettings, 'EnableMemory', messageKeys.EnableMemory);
  var enableSearch = settingValue(convertedSettings, rawSettings, 'EnableSearch', messageKeys.EnableSearch);
  var braveApiKey = settingValue(convertedSettings, rawSettings, 'BraveSearchApiKey', messageKeys.BraveSearchApiKey);
  var extraSystemPrompt = settingValue(convertedSettings, rawSettings, 'ExtraSystemPrompt', messageKeys.ExtraSystemPrompt);
  var notesMemoryText = settingValue(convertedSettings, rawSettings, 'NotesMemoryText', messageKeys.NotesMemoryText);

  if (apiKey !== undefined) {
    localStorage.setItem('OpenRouterApiKey', String(apiKey).trim());
  }
  if (model !== undefined && String(model).trim() !== '') {
    localStorage.setItem('OpenRouterModel', String(model).trim());
  }
  if (enableLocation !== undefined) {
    localStorage.setItem('EnableLocation', String(enableLocation ? 1 : 0));
  }
  if (enableMemory !== undefined) {
    localStorage.setItem('EnableMemory', String(enableMemory ? 1 : 0));
  }
  if (enableSearch !== undefined) {
    localStorage.setItem('EnableSearch', String(enableSearch ? 1 : 0));
  }
  if (braveApiKey !== undefined) {
    localStorage.setItem('BraveSearchApiKey', String(braveApiKey).trim());
  }
  if (extraSystemPrompt !== undefined) {
    localStorage.setItem('ExtraSystemPrompt', String(extraSystemPrompt).trim());
  }
  if (notesMemoryText !== undefined) {
    saveNotesFromText(notesMemoryText);
  }
}

function buildSystemPrompt() {
  var prompt = [
    'You are a practical assistant for a Pebble watch. Replies must be useful, compact, and readable on a tiny screen.',
    'Return only valid JSON: {"reply":"answer for the watch","timeline":null,"search":null,"notes":null}.',
    'Use 24-hour time. Use the provided current time, location context, search results, and notes/memory when relevant.',
    'Search tool: if current web info is needed and search is available, return {"reply":"Searching...","timeline":null,"search":"short query","notes":null}. Request search at most once; after results are provided, answer and set search null.',
    'Timeline tool: if the user asks to add/schedule/remind/put something on the timeline, set timeline to {"title":"short title","time":"ISO-8601 UTC date-time","body":"details","durationMinutes":30,"reminderMinutes":10}. If time is ambiguous, ask a short clarifying question and keep timeline null.',
    'Notes tool: add notes only for durable user preferences/facts or explicit "remember" requests. Put short note strings in notes. Do not duplicate existing memory or store temporary facts.'
  ].join(' ');
  var extra = getSetting('ExtraSystemPrompt', '');
  if (extra) {
    prompt += ' User extra instructions: ' + extra;
  }
  return prompt;
}

function buildMessages(prompt, contextText, searchResultsText) {
  var messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'system', content: 'Current time is ' + new Date().toISOString() + '.' }
  ];

  if (contextText) {
    messages.push({ role: 'system', content: contextText });
  }
  messages.push({ role: 'system', content: buildNotesContext() });
  if (searchResultsText) {
    messages.push({ role: 'system', content: searchResultsText });
  }

  var start = Math.max(0, history.length - 6);
  for (var i = start; i < history.length; i++) {
    messages.push(history[i]);
  }
  messages.push({ role: 'user', content: prompt });
  return messages;
}

function parseAssistantContent(content) {
  var text = String(content || '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  var first = text.indexOf('{');
  var last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    text = text.substring(first, last + 1);
  }

  try {
    var parsed = JSON.parse(text);
    return {
      reply: String(parsed.reply || ''),
      timeline: parsed.timeline || null,
      search: parsed.search || null,
      notes: parsed.notes || null
    };
  } catch (err) {
    return {
      reply: String(content || ''),
      timeline: null,
      search: null,
      notes: null
    };
  }
}

function extractReplyFromPartialJson(content) {
  var marker = '"reply"';
  var markerIndex = content.indexOf(marker);
  if (markerIndex === -1) {
    return '';
  }

  var colonIndex = content.indexOf(':', markerIndex + marker.length);
  if (colonIndex === -1) {
    return '';
  }

  var quoteIndex = content.indexOf('"', colonIndex + 1);
  if (quoteIndex === -1) {
    return '';
  }

  var result = '';
  var escaped = false;
  for (var i = quoteIndex + 1; i < content.length; i++) {
    var ch = content.charAt(i);
    if (escaped) {
      if (ch === 'n') {
        result += '\n';
      } else if (ch === 't') {
        result += ' ';
      } else {
        result += ch;
      }
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '"') {
      break;
    } else {
      result += ch;
    }
  }

  return result;
}

function sendAssistantDelta(delta, chunkIndex, done) {
  sendToWatch({
    Status: done ? 'Done' : 'Receiving...',
    AssistantResponse: delta,
    ResponseChunkIndex: chunkIndex,
    ResponseChunkDone: done ? 1 : 0
  });
}

function promptLooksLikeSearch(prompt) {
  prompt = String(prompt || '').toLowerCase();
  return prompt.indexOf('search') !== -1 ||
    prompt.indexOf('look up') !== -1 ||
    prompt.indexOf('latest') !== -1 ||
    prompt.indexOf('current') !== -1 ||
    prompt.indexOf('news') !== -1 ||
    prompt.indexOf('today') !== -1 ||
    prompt.indexOf('right now') !== -1 ||
    prompt.indexOf('weather') !== -1 ||
    prompt.indexOf('web') !== -1;
}

function getLocationContext(generation, callback) {
  if (!getBoolSetting('EnableLocation', false)) {
    callback('Location access disabled.');
    return;
  }

  if (!navigator.geolocation || !navigator.geolocation.getCurrentPosition) {
    callback('Location unavailable on this phone.');
    return;
  }

  sendToWatch({ Status: 'Getting location...' });
  navigator.geolocation.getCurrentPosition(function(pos) {
    if (generation !== requestGeneration) {
      return;
    }
    callback('User location: latitude ' + pos.coords.latitude + ', longitude ' + pos.coords.longitude +
      ', accuracy about ' + Math.round(pos.coords.accuracy || 0) + ' meters.');
  }, function(err) {
    if (generation !== requestGeneration) {
      return;
    }
    callback('Location requested but unavailable: ' + err.message + '.');
  }, {
    enableHighAccuracy: false,
    maximumAge: 10 * 60 * 1000,
    timeout: 10000
  });
}

function callModel(messages, generation, callback) {
  var apiKey = getSetting('OpenRouterApiKey', '');
  var model = getSetting('OpenRouterModel', DEFAULT_MODEL);

  debugLog('callModel start model=' + model + ' generation=' + generation + ' messages=' + messages.length);

  if (!apiKey) {
    showError('Open settings and add OpenRouter key.', 'Missing OpenRouter API key');
    return;
  }

  var request = new XMLHttpRequest();
  trackRequest(request, generation);
  request.open('POST', OPENROUTER_URL, true);
  request.setRequestHeader('Content-Type', 'application/json');
  request.setRequestHeader('Authorization', 'Bearer ' + apiKey);
  request.setRequestHeader('HTTP-Referer', 'https://repebble.com/');
  request.setRequestHeader('X-Title', 'Pebble AI Chat');
  request.timeout = 60000;

  request.onload = function() {
    untrackRequest(request);
    debugLog('callModel onload status=' + request.status + ' current=' + requestIsCurrent(request) + ' len=' + (request.responseText || '').length);
    if (!requestIsCurrent(request)) {
      return;
    }
    if (request.status < 200 || request.status >= 300) {
      showError('OpenRouter failed (' + request.status + ').', clip(request.responseText, 500));
      return;
    }

    try {
      var json = JSON.parse(request.responseText);
      addUsageStats(json.usage);
      var content = json.choices[0].message.content;
      debugLog('callModel content len=' + String(content || '').length + ' prefix=' + clip(content, 180));
      callback(parseAssistantContent(content));
    } catch (err) {
      showError('Bad AI response.', err.message);
    }
  };

  request.onerror = function() {
    untrackRequest(request);
    if (!requestIsCurrent(request)) {
      return;
    }
    showError('Check internet connection.', 'Network error contacting OpenRouter');
  };

  request.ontimeout = function() {
    untrackRequest(request);
    if (!requestIsCurrent(request)) {
      return;
    }
    showError('OpenRouter timed out.', 'OpenRouter request timed out');
  };

  request.send(JSON.stringify({
    model: model,
    messages: messages,
    temperature: 0.2
  }));
}

function callModelStream(messages, generation, callback) {
  var apiKey = getSetting('OpenRouterApiKey', '');
  var model = getSetting('OpenRouterModel', DEFAULT_MODEL);

  debugLog('callModelStream start model=' + model + ' generation=' + generation + ' messages=' + messages.length);

  if (!apiKey) {
    showError('Open settings and add OpenRouter key.', 'Missing OpenRouter API key');
    return;
  }

  var request = new XMLHttpRequest();
  trackRequest(request, generation);
  var processedLength = 0;
  var pendingLine = '';
  var fullContent = '';
  var sentReplyLength = 0;
  var chunkIndex = 0;
  var sentAnyChunk = false;
  var fallbackStarted = false;
  var streamWatchdog = null;

  function startNonStreamingFallback(reason) {
    if (fallbackStarted || !requestIsCurrent(request)) {
      return;
    }

    fallbackStarted = true;
    debugLog('stream fallback to non-stream reason=' + reason + ' responseLen=' + (request.responseText || '').length + ' fullContentLen=' + fullContent.length);
    untrackRequest(request);
    request._cancelled = true;
    try {
      request.abort();
    } catch (err) {
      debugLog('stream abort before fallback failed: ' + err.message);
    }
    callModel(messages, generation, function(retryParsed) {
      callback(retryParsed, false);
    });
  }

  function processSseLine(line) {
    line = line.replace(/^\s+|\s+$/g, '');
    if (line.indexOf('data:') !== 0) {
      return;
    }

    var data = line.substring(5).replace(/^\s+|\s+$/g, '');
    if (!data || data === '[DONE]') {
      return;
    }

    try {
      var json = JSON.parse(data);
      if (json.usage) {
        addUsageStats(json.usage);
        debugLog('stream usage total=' + json.usage.total_tokens + ' cost=' + json.usage.cost);
      }
      var delta = json.choices && json.choices[0] && json.choices[0].delta;
      var contentDelta = delta && delta.content ? delta.content : '';
      if (!contentDelta) {
        return;
      }

      fullContent += contentDelta;
      debugLog('stream delta len=' + contentDelta.length + ' full=' + fullContent.length);
      if (streamWatchdog) {
        clearTimeout(streamWatchdog);
        streamWatchdog = null;
      }
      var replySoFar = extractReplyFromPartialJson(fullContent);
      if (replySoFar.length > sentReplyLength) {
        var newText = replySoFar.substring(sentReplyLength);
        sendAssistantDelta(newText, chunkIndex++, false);
        sentAnyChunk = true;
        sentReplyLength = replySoFar.length;
      }
    } catch (err) {
      console.log('Could not parse stream line: ' + err.message);
    }
  }

  function processNewText() {
    var newText = request.responseText.substring(processedLength);
    processedLength = request.responseText.length;
    pendingLine += newText;

    var lines = pendingLine.split('\n');
    pendingLine = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      processSseLine(lines[i]);
    }
  }

  request.open('POST', OPENROUTER_URL, true);
  request.setRequestHeader('Content-Type', 'application/json');
  request.setRequestHeader('Accept', 'text/event-stream');
  request.setRequestHeader('Cache-Control', 'no-cache');
  request.setRequestHeader('Authorization', 'Bearer ' + apiKey);
  request.setRequestHeader('HTTP-Referer', 'https://repebble.com/');
  request.setRequestHeader('X-Title', 'Pebble AI Chat');
  request.timeout = 60000;

  request.onprogress = function() {
    if (!requestIsCurrent(request)) {
      return;
    }
    processNewText();
  };

  request.onreadystatechange = function() {
    if (request.readyState === 3 && requestIsCurrent(request)) {
      processNewText();
    }
  };

  request.onload = function() {
    if (streamWatchdog) {
      clearTimeout(streamWatchdog);
      streamWatchdog = null;
    }
    untrackRequest(request);
    if (fallbackStarted) {
      return;
    }
    debugLog('callModelStream onload status=' + request.status + ' current=' + requestIsCurrent(request) + ' responseLen=' + (request.responseText || '').length + ' fullContentLen=' + fullContent.length);
    if (!requestIsCurrent(request)) {
      return;
    }
    if (request.status < 200 || request.status >= 300) {
      showError('OpenRouter failed (' + request.status + ').', clip(request.responseText, 500));
      return;
    }

    processNewText();
    if (pendingLine) {
      processSseLine(pendingLine);
      pendingLine = '';
    }

    var parsed = parseAssistantContent(fullContent);
    var finalReply = parsed.reply || extractReplyFromPartialJson(fullContent) || 'No response.';
    debugLog('stream final replyLen=' + finalReply.length + ' search=' + !!parsed.search + ' notes=' + !!parsed.notes + ' prefix=' + clip(finalReply, 180));
    if (!fullContent || finalReply === 'No response.') {
      startNonStreamingFallback('empty-final');
      return;
    }

    if (!sentAnyChunk) {
      sendAssistantDelta(finalReply, 0, true);
      sentAnyChunk = true;
    } else {
      var missingText = finalReply.substring(sentReplyLength);
      if (missingText) {
        sendAssistantDelta(missingText, chunkIndex++, false);
      }
      sendAssistantDelta('', chunkIndex, true);
    }

    parsed.reply = finalReply;
    callback(parsed, true);
  };

  request.onerror = function() {
    if (streamWatchdog) {
      clearTimeout(streamWatchdog);
      streamWatchdog = null;
    }
    untrackRequest(request);
    if (!requestIsCurrent(request) || fallbackStarted) {
      return;
    }
    showError('Check internet connection.', 'Network error contacting OpenRouter');
  };

  request.ontimeout = function() {
    if (streamWatchdog) {
      clearTimeout(streamWatchdog);
      streamWatchdog = null;
    }
    untrackRequest(request);
    if (!requestIsCurrent(request) || fallbackStarted) {
      return;
    }
    startNonStreamingFallback('stream-timeout');
  };

  streamWatchdog = setTimeout(function() {
    if (!sentAnyChunk && !fullContent) {
      startNonStreamingFallback('no-stream-after-8s');
    }
  }, 8000);

  request.send(JSON.stringify({
    model: model,
    messages: messages,
    temperature: 0.2,
    stream: true
  }));
}

function braveSearch(query, generation, callback) {
  var apiKey = getSetting('BraveSearchApiKey', '');
  debugLog('braveSearch start query=' + query + ' generation=' + generation);
  if (!getBoolSetting('EnableSearch', false) || !apiKey) {
    callback(null, 'Search unavailable. Add Brave key in settings.');
    return;
  }

  sendToWatch({ Status: 'Searching...' });
  incrementStat('searches');
  sendStatsToWatch();
  var request = new XMLHttpRequest();
  trackRequest(request, generation);
  request.open('GET', BRAVE_SEARCH_URL + '?count=' + MAX_SEARCH_RESULTS + '&q=' + encodeURIComponent(query), true);
  request.setRequestHeader('Accept', 'application/json');
  request.setRequestHeader('X-Subscription-Token', apiKey);
  request.timeout = 30000;

  request.onload = function() {
    untrackRequest(request);
    debugLog('braveSearch onload status=' + request.status + ' current=' + requestIsCurrent(request));
    if (!requestIsCurrent(request)) {
      return;
    }
    if (request.status < 200 || request.status >= 300) {
      callback(null, 'Brave Search failed (' + request.status + ').');
      return;
    }

    try {
      var json = JSON.parse(request.responseText);
      var results = json.web && json.web.results ? json.web.results : [];
      var lines = ['Web search results for: ' + query];
      for (var i = 0; i < results.length && i < MAX_SEARCH_RESULTS; i++) {
        lines.push((i + 1) + '. ' + (results[i].title || 'Untitled'));
        lines.push('URL: ' + (results[i].url || ''));
        lines.push('Snippet: ' + (results[i].description || ''));
      }
      if (results.length === 0) {
        lines.push('No results found.');
      }
      callback(lines.join('\n'), null);
    } catch (err) {
      callback(null, 'Bad search response.');
    }
  };

  request.onerror = function() {
    untrackRequest(request);
    if (!requestIsCurrent(request)) {
      return;
    }
    callback(null, 'Search network error.');
  };

  request.ontimeout = function() {
    untrackRequest(request);
    if (!requestIsCurrent(request)) {
      return;
    }
    callback(null, 'Search timed out.');
  };

  request.send();
}

function finishAssistantTurn(prompt, parsed, alreadySent) {
  var reply = parsed.reply || 'No response.';
  debugLog('finishAssistantTurn alreadySent=' + alreadySent + ' replyLen=' + reply.length + ' prefix=' + clip(reply, 180));
  history.push({ role: 'user', content: prompt });
  history.push({ role: 'assistant', content: reply });
  if (history.length > 12) {
    history = history.slice(history.length - 12);
  }

  if (!alreadySent) {
    sendAssistantReply(reply);
  }

  if (parsed.timeline) {
    addTimelinePin(parsed.timeline);
  }

  if (parsed.notes) {
    if (getBoolSetting('EnableMemory', true)) {
      addNotes(parsed.notes);
    }
  }

  sendStatsToWatch();
}

function callOpenRouter(prompt) {
  requestGeneration++;
  var generation = requestGeneration;
  debugLog('callOpenRouter promptLen=' + String(prompt || '').length + ' generation=' + generation + ' searchLooks=' + promptLooksLikeSearch(prompt));
  incrementStat('messages');
  sendStatsToWatch();
  sendToWatch({ Status: 'Thinking...' });
  getLocationContext(generation, function(locationContext) {
    var searchAvailable = getBoolSetting('EnableSearch', false) && !!getSetting('BraveSearchApiKey', '');
    debugLog('context ready searchAvailable=' + searchAvailable + ' locationContext=' + clip(locationContext, 120));
    var contextText = locationContext + '\nSearch available: ' + (searchAvailable ? 'yes, request search with the search field when needed.' : 'no.') ;
    var firstMessages = buildMessages(prompt, contextText, null);

    if (!searchAvailable || !promptLooksLikeSearch(prompt)) {
      callModelStream(firstMessages, generation, function(parsed, alreadySent) {
        finishAssistantTurn(prompt, parsed, alreadySent);
      });
      return;
    }

    callModel(firstMessages, generation, function(parsed) {
      if (parsed.search) {
        braveSearch(String(parsed.search), generation, function(searchResultsText, searchError) {
          if (searchError) {
            showError(searchError, 'Search query: ' + parsed.search);
            return;
          }
          sendToWatch({ Status: 'Thinking...' });
          var secondMessages = buildMessages(prompt, contextText, searchResultsText);
          callModelStream(secondMessages, generation, function(finalParsed, alreadySent) {
            finishAssistantTurn(prompt, finalParsed, alreadySent);
          });
        });
      } else {
        finishAssistantTurn(prompt, parsed, false);
      }
    });
  });
}

function normalizeTimeline(timeline) {
  var title = clip(timeline.title || 'AI Timeline Item', 64);
  var body = clip(timeline.body || title, 512);
  var time = new Date(timeline.time);
  var now = new Date();

  if (!timeline.time || isNaN(time.getTime())) {
    throw new Error('Missing timeline time.');
  }

  if (time.getTime() < now.getTime() - (2 * 24 * 60 * 60 * 1000)) {
    throw new Error('Timeline time is too far in the past.');
  }

  var duration = parseInt(timeline.durationMinutes, 10);
  if (isNaN(duration) || duration < 0) {
    duration = 30;
  }

  var id = 'ai-chat-' + now.getTime() + '-' + Math.floor(Math.random() * 100000);
  var pin = {
    id: id,
    time: time.toISOString(),
    duration: duration,
    layout: {
      type: 'genericPin',
      title: title,
      tinyIcon: 'system://images/TIMELINE_CALENDAR',
      body: body
    },
    createNotification: {
      layout: {
        type: 'genericNotification',
        title: 'Timeline Added',
        tinyIcon: 'system://images/NOTIFICATION_FLAG',
        body: title
      }
    }
  };

  var reminderMinutes = parseInt(timeline.reminderMinutes, 10);
  if (!isNaN(reminderMinutes) && reminderMinutes > 0) {
    var reminderTime = new Date(time.getTime() - reminderMinutes * 60 * 1000);
    if (reminderTime.getTime() > now.getTime()) {
      pin.reminders = [{
        time: reminderTime.toISOString(),
        layout: {
          type: 'genericReminder',
          title: title,
          tinyIcon: 'system://images/ALARM_CLOCK'
        }
      }];
    }
  }

  return pin;
}

function addTimelinePin(timeline) {
  var pin;
  try {
    pin = normalizeTimeline(timeline);
  } catch (err) {
    console.log('Timeline pin not added: ' + err.message);
    return;
  }

  Pebble.getTimelineToken(function(token) {
    var request = new XMLHttpRequest();
    request.open('PUT', TIMELINE_URL + encodeURIComponent(pin.id), true);
    request.setRequestHeader('Content-Type', 'application/json');
    request.setRequestHeader('X-User-Token', token);
    request.timeout = 30000;

    request.onload = function() {
      if (request.status < 200 || request.status >= 300) {
        console.log('Timeline error ' + request.status + ': ' + request.responseText);
      }
    };

    request.onerror = function() {
      console.log('Timeline network error');
    };

    request.ontimeout = function() {
      console.log('Timeline timed out');
    };

    request.send(JSON.stringify(pin));
  }, function(error) {
    console.log('No timeline token: ' + clip(error, 80));
  });
}

Pebble.addEventListener('ready', function() {
  console.log('PebbleKit JS ready');
  sendStatsToWatch();
  refreshRemainingCredits();
});

Pebble.addEventListener('appmessage', function(e) {
  if (e.payload && e.payload.RefreshStats) {
    sendStatsToWatch();
    refreshRemainingCredits();
    return;
  }

  if (e.payload && e.payload.ToggleLocation) {
    var locationEnabled = toggleBoolSetting('EnableLocation', false);
    sendToWatch({ Status: locationEnabled ? 'Location on' : 'Location off' });
    sendStatsToWatch();
    return;
  }

  if (e.payload && e.payload.ToggleMemory) {
    var memoryEnabled = toggleBoolSetting('EnableMemory', true);
    sendToWatch({ Status: memoryEnabled ? 'Memory on' : 'Memory off' });
    sendStatsToWatch();
    return;
  }

  if (e.payload && e.payload.CancelRequest) {
    cancelActiveRequests();
    return;
  }

  if (e.payload && e.payload.ClearSession) {
    cancelActiveRequests();
    history = [];
    sendToWatch({ Status: 'New session' });
    return;
  }

  var prompt = e.payload && e.payload.Prompt;
  if (prompt) {
    callOpenRouter(prompt);
  }
});

Pebble.addEventListener('showConfiguration', function() {
  clay.setSettings({
    NotesMemoryText: notesToText(),
    ExtraSystemPrompt: getSetting('ExtraSystemPrompt', ''),
    OpenRouterApiKey: getSetting('OpenRouterApiKey', ''),
    OpenRouterModel: getSetting('OpenRouterModel', DEFAULT_MODEL),
    EnableLocation: getBoolSetting('EnableLocation', false),
    EnableMemory: getBoolSetting('EnableMemory', true),
    EnableSearch: getBoolSetting('EnableSearch', false),
    BraveSearchApiKey: getSetting('BraveSearchApiKey', ''),
    DebugLog: localStorage.getItem('DebugLog') || ''
  });
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function(e) {
  if (!e || !e.response) {
    return;
  }

  var convertedSettings = clay.getSettings(e.response);
  var rawSettings = clay.getSettings(e.response, false);
  saveSettings(convertedSettings, rawSettings);
  sendToWatch({ Status: 'Settings saved' });
  sendStatsToWatch();
  refreshRemainingCredits();
});
