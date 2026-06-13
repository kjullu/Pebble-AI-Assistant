module.exports = [
  {
    "type": "heading",
    "defaultValue": "AI Chat"
  },
  {
    "type": "text",
    "defaultValue": "Enter your OpenRouter API key and model. The key is stored by the Pebble phone app for this watchapp."
  },
  {
    "type": "section",
    "items": [
      {
        "type": "input",
        "messageKey": "OpenRouterApiKey",
        "label": "OpenRouter API Key",
        "attributes": {
          "placeholder": "sk-or-v1-..."
        }
      },
      {
        "type": "input",
        "messageKey": "OpenRouterModel",
        "defaultValue": "openai/gpt-4o-mini",
        "label": "Model",
        "attributes": {
          "placeholder": "openai/gpt-4o-mini"
        }
      },
      {
        "type": "toggle",
        "messageKey": "EnableLocation",
        "label": "Give AI Location",
        "defaultValue": false
      },
      {
        "type": "toggle",
        "messageKey": "EnableSearch",
        "label": "Enable Brave Search",
        "defaultValue": false
      },
      {
        "type": "input",
        "messageKey": "BraveSearchApiKey",
        "label": "Brave Search API Key",
        "attributes": {
          "placeholder": "Brave API key"
        }
      }
    ]
  },
  {
    "type": "submit",
    "defaultValue": "Save"
  }
];
