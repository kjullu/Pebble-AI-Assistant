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
        "defaultValue": "moonshotai/kimi-k2.5",
        "label": "Model",
        "attributes": {
          "placeholder": "moonshotai/kimi-k2.5"
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
        "messageKey": "EnableMemory",
        "label": "Enable Memory",
        "defaultValue": true
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
      },
      {
        "type": "input",
        "messageKey": "ExtraSystemPrompt",
        "label": "Extra System Prompt",
        "description": "Optional extra instructions added after the built-in prompt.",
        "attributes": {
          "placeholder": "Example: Be terse and use Danish when I ask in Danish."
        }
      },
      {
        "type": "input",
        "messageKey": "NotesMemoryText",
        "label": "Memory Notes",
        "description": "One note per line. These are sent to the AI as memory.",
        "attributes": {
          "placeholder": "User prefers 24-hour time."
        }
      }
    ]
  },
  {
    "type": "submit",
    "defaultValue": "Save"
  }
];
