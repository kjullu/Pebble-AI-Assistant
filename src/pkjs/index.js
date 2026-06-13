var Clay = require('@rebble/clay');
var messageKeys = require('message_keys');
var clayConfig = require('./config');
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
var TIMELINE_URL = 'https://timeline-api.getpebble.com/v1/user/pins/';
var DEFAULT_MODEL = 'openai/gpt-4o-mini';
var RESPONSE_CHUNK_CHARS = 700;

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

  if (apiKey !== undefined) {
    localStorage.setItem('OpenRouterApiKey', String(apiKey).trim());
  }
  if (model !== undefined && String(model).trim() !== '') {
    localStorage.setItem('OpenRouterModel', String(model).trim());
  }
}

function buildSystemPrompt() {
  return [
    'You are a concise assistant running on a Pebble watch.',
    'Always return only valid JSON with this shape:',
    '{"reply":"short user-visible answer","timeline":null}',
    'If the user asks you to add, schedule, remind, or put something on the timeline, set timeline to:',
    '{"title":"short title","time":"ISO-8601 UTC date-time","body":"details","durationMinutes":30,"reminderMinutes":10}',
    'Use the current time for relative dates. If a time is ambiguous, ask a short clarifying question and set timeline to null.',
    'Keep replies practical for a watch display unless the user asks for detail.'
  ].join(' ');
}

function buildMessages(prompt) {
  var messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'system', content: 'Current time is ' + new Date().toISOString() + '.' }
  ];

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
      timeline: parsed.timeline || null
    };
  } catch (err) {
    return {
      reply: String(content || ''),
      timeline: null
    };
  }
}

function callOpenRouter(prompt) {
  var apiKey = getSetting('OpenRouterApiKey', '');
  var model = getSetting('OpenRouterModel', DEFAULT_MODEL);

  if (!apiKey) {
    sendToWatch({
      Error: 'Open the Pebble phone app settings for AI Chat and enter your OpenRouter API key.'
    });
    return;
  }

  sendToWatch({ Status: 'Thinking...' });

  var request = new XMLHttpRequest();
  request.open('POST', OPENROUTER_URL, true);
  request.setRequestHeader('Content-Type', 'application/json');
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
      var parsed = parseAssistantContent(content);
      var reply = parsed.reply || 'No response.';

      history.push({ role: 'user', content: prompt });
      history.push({ role: 'assistant', content: reply });
      if (history.length > 12) {
        history = history.slice(history.length - 12);
      }

      sendAssistantReply(reply);

      if (parsed.timeline) {
        addTimelinePin(parsed.timeline);
      }
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
    messages: buildMessages(prompt),
    temperature: 0.2
  }));
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
