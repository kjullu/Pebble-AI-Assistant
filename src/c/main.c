#include <pebble.h>

// Max characters Pebble dictation should store for one spoken prompt.
#define DICTATION_BUFFER_SIZE 512
// Large enough to hold the full text currently shown in the text layer.
#define DISPLAY_BUFFER_SIZE 8192
// Stores the accumulated assistant reply received from the phone.
#define RESPONSE_BUFFER_SIZE 6144

// Pointers to Pebble UI/session objects created at runtime.
static Window *s_window;
static ScrollLayer *s_scroll_layer;
static TextLayer *s_text_layer;
static DictationSession *s_dictation_session;

// These buffers hold the current conversation state shown in the single text view.
static char s_last_prompt[DICTATION_BUFFER_SIZE];
static char s_assistant_response[RESPONSE_BUFFER_SIZE];
static char s_display_text[DISPLAY_BUFFER_SIZE];

// Long assistant replies arrive from the phone as multiple AppMessage chunks.
static void append_response_chunk(const char *chunk) {
  // Find out how much space is left so we do not overflow the response buffer.
  size_t current_len = strlen(s_assistant_response);
  size_t remaining = sizeof(s_assistant_response) - current_len - 1;
  if (remaining > 0) {
    strncat(s_assistant_response, chunk, remaining);
  }
}

// Rebuild the full screen text whenever prompt, status, or response changes.
static void update_display(const char *status) {
  // Fall back to helpful placeholder text before the user has spoken or received a reply.
  const char *prompt = s_last_prompt[0] ? s_last_prompt : "Press SELECT and speak.";
  const char *response = s_assistant_response[0] ? s_assistant_response : "No response yet.";

  // Build the single scrollable text blob shown in the app.
  snprintf(s_display_text, sizeof(s_display_text),
           "%s\n\nYou:\n%s\n\nAssistant:\n%s\n\nSELECT: speak\nUP/DOWN: scroll",
           status ? status : "Ready", prompt, response);

  // Push the new text into the layer and resize scrolling to fit it.
  text_layer_set_text(s_text_layer, s_display_text);
  GSize content_size = text_layer_get_content_size(s_text_layer);
  text_layer_set_size(s_text_layer, GSize(content_size.w, content_size.h + 8));
  scroll_layer_set_content_size(s_scroll_layer, GSize(content_size.w, content_size.h + 8));
  scroll_layer_set_content_offset(s_scroll_layer, GPointZero, false);
}

// Send the user's dictated text to PebbleKit JS on the phone.
static void send_prompt(const char *prompt) {
  // Ignore empty prompts so we do not send meaningless AppMessages.
  if (!prompt || !prompt[0]) {
    update_display("Nothing to send");
    return;
  }

  // Store the latest prompt locally and clear the previous assistant reply.
  snprintf(s_last_prompt, sizeof(s_last_prompt), "%s", prompt);
  s_assistant_response[0] = '\0';
  update_display("Sending...");

  // Start building an outgoing AppMessage dictionary.
  DictionaryIterator *iter;
  AppMessageResult result = app_message_outbox_begin(&iter);
  if (result != APP_MSG_OK || !iter) {
    update_display("Phone not ready");
    return;
  }

  // Put the prompt into the message under the Prompt key, then send it.
  dict_write_cstring(iter, MESSAGE_KEY_Prompt, s_last_prompt);
  dict_write_end(iter);
  result = app_message_outbox_send();
  if (result != APP_MSG_OK) {
    update_display("Send failed");
  }
}

// Receive status, errors, and response chunks from PebbleKit JS.
static void inbox_received_callback(DictionaryIterator *iter, void *context) {
  //USR: Define suff...
  //AI: Look up any known fields that may be present in this incoming AppMessage.
  Tuple *status_tuple = dict_find(iter, MESSAGE_KEY_Status);
  Tuple *response_tuple = dict_find(iter, MESSAGE_KEY_AssistantResponse);
  Tuple *chunk_index_tuple = dict_find(iter, MESSAGE_KEY_ResponseChunkIndex);
  Tuple *error_tuple = dict_find(iter, MESSAGE_KEY_Error);

  //USR: Default status to Ready. if status_tuple- is set, then use that for status (as a string?)
  //AI: Default to "Ready" unless the phone sent a different status string.
  const char *status = "Ready";
  if (status_tuple) {
    status = status_tuple->value->cstring;
  }

  //USR: if response_tuple is true do:
  //AI: If the message includes assistant text, process it.
  if (response_tuple) {
    //USR: se if AI respnse
    //AI: A chunk index means the reply is arriving in multiple AppMessages.
    if (chunk_index_tuple) {
      //USR: Yes, se if first word??
      //AI: Chunk 0 starts a new reply, so clear the previous response first.
      if (chunk_index_tuple->value->int32 == 0) {
        s_assistant_response[0] = '\0';
      }
      //USR: else add to rest of response
      //AI: Add this chunk's text onto the full assistant response buffer.
      append_response_chunk(response_tuple->value->cstring);
    } else {
      //USR: Else do normal start screen with status
      //AI: No chunk index means this is a complete one-piece response, so replace the old text.
      snprintf(s_assistant_response, sizeof(s_assistant_response), "%s", response_tuple->value->cstring);
    }
  }

  //USR: If error, print error
  //AI: If the phone sent an error, show it in place of the assistant response and mark status as Error.
  if (error_tuple) {
    snprintf(s_assistant_response, sizeof(s_assistant_response), "%s", error_tuple->value->cstring);
    status = "Error";
  }

  //USR: Update text/display with new info
  //AI: Rebuild and redraw the watch text view using the latest status and response.
  update_display(status);
}

// Pebble dictation calls this after speech recognition succeeds or fails.
//USR: If user has finished their dictation, then send it to the Phone, else update the display with a "Dictation cancelled"
//AI: If speech recognition succeeded, send the transcription to the phone; otherwise show "Dictation cancelled".
static void dictation_callback(DictationSession *session, DictationSessionStatus status,
                               char *transcription, void *context) {
  if (status == DictationSessionStatusSuccess) {
    // Forward the recognized speech to the phone-side JS for AI processing.
    send_prompt(transcription);
  } else {
    // Any non-success status is treated as a cancelled/failed dictation attempt.
    update_display("Dictation cancelled");
  }
}

// SELECT is the only app-specific button action; UP/DOWN are kept for scrolling.
static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  // Ask Pebble to show its dictation UI and start listening to the microphone.
  dictation_session_start(s_dictation_session);
}

// The ScrollLayer installs UP/DOWN scrolling, then calls this so SELECT can be added.
static void scroll_click_config_provider(void *context) {
  // Bind the SELECT button to our custom handler.
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
}

// Create the plain scrollable text UI.
static void window_load(Window *window) {
  // Get the root layer and its bounds so child layers can be sized to fill the screen.
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  // Create a ScrollLayer so long responses can be read with UP/DOWN.
  s_scroll_layer = scroll_layer_create(bounds);
  scroll_layer_set_callbacks(s_scroll_layer, (ScrollLayerCallbacks) {
    .click_config_provider = scroll_click_config_provider
  });
  scroll_layer_set_click_config_onto_window(s_scroll_layer, window);
  layer_add_child(window_layer, scroll_layer_get_layer(s_scroll_layer));

  // Create one large TextLayer inside the scroll layer to hold the whole conversation.
  s_text_layer = text_layer_create(GRect(4, 0, bounds.size.w - 8, 2000));
  text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_color(s_text_layer, GColorBlack);
  text_layer_set_background_color(s_text_layer, GColorWhite);
  scroll_layer_add_child(s_scroll_layer, text_layer_get_layer(s_text_layer));

  // Show the initial idle screen.
  update_display("Ready");
}

// Destroy UI objects created in window_load().
static void window_unload(Window *window) {
  // These objects were heap-allocated in window_load(), so they must be destroyed here.
  text_layer_destroy(s_text_layer);
  scroll_layer_destroy(s_scroll_layer);
}

// App setup: create the window, open AppMessage, and create dictation.
static void init(void) {
  s_window = window_create(); //USR: Create window and call it s_window
  //AI: Creates a Window object and stores its pointer in s_window.
  window_set_window_handlers(s_window, (WindowHandlers) { //USR: something with the scroll layer?
    //AI: Register which functions Pebble should call when this window loads and unloads.
    .load = window_load,
    .unload = window_unload
  });
  window_stack_push(s_window, true); //USR: Make our window appear on the screen
  //AI: Push the window onto Pebble's window stack so it appears on screen, with animation.

  app_message_register_inbox_received(inbox_received_callback); //USR: IDK, something with the AppMessage?
  //AI: Register the function that should run when a message arrives from the phone.
  app_message_open(2048, 1024); //USR: AGAIN, something with the AppMessage?
  //AI: Open AppMessage and reserve 2048 bytes for incoming messages and 1024 for outgoing ones.

  s_dictation_session = dictation_session_create(DICTATION_BUFFER_SIZE, dictation_callback, NULL); //USR: Start the dictation deamon? with a buffersize?
  //AI: Create a dictation session; Pebble will call dictation_callback when speech recognition finishes.
  dictation_session_enable_confirmation(s_dictation_session, true); // Purposly set to true
}

// Release resources before the app exits.
static void deinit(void) {
  // Tear down runtime objects created during init().
  dictation_session_destroy(s_dictation_session);
  window_destroy(s_window);
}

int main(void) {
  // Set up the app's objects and message handlers.
  init();
  // Hand control to Pebble so it can dispatch button, dictation, and AppMessage events.
  app_event_loop();
  // Clean up after the event loop exits, usually when the app is closing.
  deinit();
}
