var Clay = require('@rebble/clay');
var messageKeys = require('message_keys');
var clayConfig = require('./config');
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
var BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
var TIMELINE_URL = 'https://timeline-api.getpebble.com/v1/user/pins/';
var DEFAULT_MODEL = 'openai/gpt-4o-mini';
var RESPONSE_CHUNK_CHARS = 700;
var MAX_SEARCH_RESULTS = 3;
var MAX_NOTES = 30;
var MAX_NOTE_CHARS = 240;

var history = [];
var sendQueue = [];
var sending = false;

function sendToWatch(dict) {
  sendQueue.push(dict);
  pumpSendQueue();
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
  var enableSearch = settingValue(convertedSettings, rawSettings, 'EnableSearch', messageKeys.EnableSearch);
  var braveApiKey = settingValue(convertedSettings, rawSettings, 'BraveSearchApiKey', messageKeys.BraveSearchApiKey);

  if (apiKey !== undefined) {
    localStorage.setItem('OpenRouterApiKey', String(apiKey).trim());
  }
  if (model !== undefined && String(model).trim() !== '') {
    localStorage.setItem('OpenRouterModel', String(model).trim());
  }
  if (enableLocation !== undefined) {
    localStorage.setItem('EnableLocation', String(enableLocation ? 1 : 0));
  }
  if (enableSearch !== undefined) {
    localStorage.setItem('EnableSearch', String(enableSearch ? 1 : 0));
  }
  if (braveApiKey !== undefined) {
    localStorage.setItem('BraveSearchApiKey', String(braveApiKey).trim());
  }
}

function buildSystemPrompt() {
  return [
    'You are a concise assistant running on a Pebble watch.',
    'Always return only valid JSON with this shape:',
    '{"reply":"short user-visible answer","timeline":null,"search":null,"notes":null}',
    'You have a notes/memory tool. When the user asks you to remember something, or tells you a durable preference/fact worth remembering, put one or more short note strings in notes.',
    'Only add useful long-term notes. Do not add notes for temporary facts, ordinary questions, or things already present in memory.',
    'If you need current web information and search is available, return {"reply":"Searching...","timeline":null,"search":"short search query"}.',
    'Only request search once per user question. After search results are provided, answer from those results and set search to null.',
    'If the user asks you to add, schedule, remind, or put something on the timeline, set timeline to:',
    '{"title":"short title","time":"ISO-8601 UTC date-time","body":"details","durationMinutes":30,"reminderMinutes":10}',
    'Use the current time for relative dates. If a time is ambiguous, ask a short clarifying question and set timeline to null.',
    'Keep replies practical for a watch display unless the user asks for detail.',
    'You should generally use 24h time when talking to the user.'
  ].join(' ');
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

function getLocationContext(callback) {
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
    callback('User location: latitude ' + pos.coords.latitude + ', longitude ' + pos.coords.longitude +
      ', accuracy about ' + Math.round(pos.coords.accuracy || 0) + ' meters.');
  }, function(err) {
    callback('Location requested but unavailable: ' + err.message + '.');
  }, {
    enableHighAccuracy: false,
    maximumAge: 10 * 60 * 1000,
    timeout: 10000
  });
}

function callModel(messages, callback) {
  var apiKey = getSetting('OpenRouterApiKey', '');
  var model = getSetting('OpenRouterModel', DEFAULT_MODEL);

  if (!apiKey) {
    sendToWatch({
      Error: 'Open the Pebble phone app settings for AI Chat and enter your OpenRouter API key.'
    });
    return;
  }

  var request = new XMLHttpRequest();
  request.open('POST', OPENROUTER_URL, true);
  request.setRequestHeader('Content-Type', 'application/json');
  request.setRequestHeader('Accept', 'text/event-stream');
  request.setRequestHeader('Cache-Control', 'no-cache');
  request.setRequestHeader('Authorization', 'Bearer ' + apiKey);
  request.setRequestHeader('HTTP-Referer', 'https://repebble.com/');
  request.setRequestHeader('X-Title', 'Pebble AI Chat');
  request.timeout = 60000;

  request.onload = function() {
    if (request.status < 200 || request.status >= 300) {
      sendToWatch({ Error: 'OpenRouter error ' + request.status + ': ' + clip(request.responseText, 400) });
      return;
    }

    try {
      var json = JSON.parse(request.responseText);
      var content = json.choices[0].message.content;
      callback(parseAssistantContent(content));
    } catch (err) {
      sendToWatch({ Error: 'Bad OpenRouter response: ' + err.message });
    }
  };

  request.onerror = function() {
    sendToWatch({ Error: 'Network error contacting OpenRouter.' });
  };

  request.ontimeout = function() {
    sendToWatch({ Error: 'OpenRouter request timed out.' });
  };

  request.send(JSON.stringify({
    model: model,
    messages: messages,
    temperature: 0.2
  }));
}

function callModelStream(messages, callback) {
  var apiKey = getSetting('OpenRouterApiKey', '');
  var model = getSetting('OpenRouterModel', DEFAULT_MODEL);

  if (!apiKey) {
    sendToWatch({
      Error: 'Open the Pebble phone app settings for AI Chat and enter your OpenRouter API key.'
    });
    return;
  }

  var request = new XMLHttpRequest();
  var processedLength = 0;
  var pendingLine = '';
  var fullContent = '';
  var sentReplyLength = 0;
  var chunkIndex = 0;
  var sentAnyChunk = false;

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
      var delta = json.choices && json.choices[0] && json.choices[0].delta;
      var contentDelta = delta && delta.content ? delta.content : '';
      if (!contentDelta) {
        return;
      }

      fullContent += contentDelta;
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
  request.setRequestHeader('Authorization', 'Bearer ' + apiKey);
  request.setRequestHeader('HTTP-Referer', 'https://repebble.com/');
  request.setRequestHeader('X-Title', 'Pebble AI Chat');
  request.timeout = 60000;

  request.onprogress = function() {
    processNewText();
  };

  request.onreadystatechange = function() {
    if (request.readyState === 3) {
      processNewText();
    }
  };

  request.onload = function() {
    if (request.status < 200 || request.status >= 300) {
      sendToWatch({ Error: 'OpenRouter error ' + request.status + ': ' + clip(request.responseText, 400) });
      return;
    }

    processNewText();
    if (pendingLine) {
      processSseLine(pendingLine);
      pendingLine = '';
    }

    var parsed = parseAssistantContent(fullContent);
    var finalReply = parsed.reply || extractReplyFromPartialJson(fullContent) || 'No response.';
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
    sendToWatch({ Error: 'Network error contacting OpenRouter.' });
  };

  request.ontimeout = function() {
    sendToWatch({ Error: 'OpenRouter request timed out.' });
  };

  request.send(JSON.stringify({
    model: model,
    messages: messages,
    temperature: 0.2,
    stream: true
  }));
}

function braveSearch(query, callback) {
  var apiKey = getSetting('BraveSearchApiKey', '');
  if (!getBoolSetting('EnableSearch', false) || !apiKey) {
    callback('Search unavailable: Brave Search is disabled or missing an API key.');
    return;
  }

  sendToWatch({ Status: 'Searching...' });
  var request = new XMLHttpRequest();
  request.open('GET', BRAVE_SEARCH_URL + '?count=' + MAX_SEARCH_RESULTS + '&q=' + encodeURIComponent(query), true);
  request.setRequestHeader('Accept', 'application/json');
  request.setRequestHeader('X-Subscription-Token', apiKey);
  request.timeout = 30000;

  request.onload = function() {
    if (request.status < 200 || request.status >= 300) {
      callback('Search failed with HTTP ' + request.status + '.');
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
      callback(lines.join('\n'));
    } catch (err) {
      callback('Search response could not be parsed: ' + err.message + '.');
    }
  };

  request.onerror = function() {
    callback('Search network error.');
  };

  request.ontimeout = function() {
    callback('Search timed out.');
  };

  request.send();
}

function finishAssistantTurn(prompt, parsed, alreadySent) {
  var reply = parsed.reply || 'No response.';
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
    addNotes(parsed.notes);
  }
}

function callOpenRouter(prompt) {
  sendToWatch({ Status: 'Thinking...' });
  getLocationContext(function(locationContext) {
    var searchAvailable = getBoolSetting('EnableSearch', false) && !!getSetting('BraveSearchApiKey', '');
    var contextText = locationContext + '\nSearch available: ' + (searchAvailable ? 'yes, request search with the search field when needed.' : 'no.') ;
    var firstMessages = buildMessages(prompt, contextText, null);

    if (!searchAvailable || !promptLooksLikeSearch(prompt)) {
      callModelStream(firstMessages, function(parsed, alreadySent) {
        finishAssistantTurn(prompt, parsed, alreadySent);
      });
      return;
    }

    callModel(firstMessages, function(parsed) {
      if (parsed.search) {
        braveSearch(String(parsed.search), function(searchResultsText) {
          sendToWatch({ Status: 'Thinking...' });
          var secondMessages = buildMessages(prompt, contextText, searchResultsText);
          callModelStream(secondMessages, function(finalParsed, alreadySent) {
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
});

Pebble.addEventListener('appmessage', function(e) {
  if (e.payload && e.payload.ClearSession) {
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
});
