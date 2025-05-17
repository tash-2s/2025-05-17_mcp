@component
export class Speech extends BaseScriptComponent {
  @input
  @hint("Text component to display transcription")
  @label("Transcription Text")
  transcriptionText: Text;

  private asrModule = require('LensStudio:AsrModule');
  private remoteServiceModule = require("LensStudio:InternetModule");

  private onTranscriptionUpdate(eventArgs: AsrModule.TranscriptionUpdateEvent) {
    // Update the UI text component with transcription
    if (this.transcriptionText) {
      this.transcriptionText.text = eventArgs.text;
    }

    // Still keep the console output for debugging
    print(
      `onTranscriptionUpdateCallback text=${eventArgs.text}, isFinal=${eventArgs.isFinal}`
    );

    // Send final transcription to local server
    if (eventArgs.isFinal && eventArgs.text.trim().length >= 5) {
      this.sendTranscriptionToLocalServer(eventArgs.text);
      print(`Sending final transcription to server: "${eventArgs.text}"`);
    } else if (eventArgs.isFinal) {
      print(`Ignoring short transcription (< 5 chars): "${eventArgs.text}"`);
    }
  }

  private onTranscriptionError(eventArgs: AsrModule.AsrStatusCode) {
    print(`onTranscriptionErrorCallback errorCode: ${eventArgs}`);

    let errorMessage = "";
    switch (eventArgs) {
      case AsrModule.AsrStatusCode.InternalError:
        errorMessage = 'Internal Error';
        print('stopTranscribing: Internal Error');
        break;
      case AsrModule.AsrStatusCode.Unauthenticated:
        errorMessage = 'Unauthenticated';
        print('stopTranscribing: Unauthenticated');
        break;
      case AsrModule.AsrStatusCode.NoInternet:
        errorMessage = 'No Internet Connection';
        print('stopTranscribing: No Internet');
        break;
    }

    // Show error message in the text component
    if (this.transcriptionText && errorMessage) {
      this.transcriptionText.text = "Error: " + errorMessage;
    }
  }

  private sendTranscriptionToLocalServer(transcript: string) {
    try {
      const payload = {
        transcript: transcript
      };

      const request = new Request("http://localhost:3000/media", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      // Send without waiting for response
      this.remoteServiceModule.fetch(request)
        .then(response => {
          if (response.status === 200) {
            print("Successfully sent transcript to local server");
          } else {
            print("WARNING: Failed to send transcript to local server, status: " + response.status);
          }
        })
        .catch(error => {
          print("WARNING: Error sending transcript to local server: " + error);
        });
    } catch (error) {
      print("WARNING: Error preparing transcript request: " + error);
    }
  }

  onAwake(): void {
    // Initialize text component
    if (this.transcriptionText) {
      this.transcriptionText.text = "Listening...";
    } else {
      print("ERROR: Please assign a text component for transcription display");
    }

    const options = AsrModule.AsrTranscriptionOptions.create();
    // Increase silence duration to allow for better sentence completion
    options.silenceUntilTerminationMs = 2000; // 2 seconds of silence
    options.mode = AsrModule.AsrMode.HighAccuracy;
    options.onTranscriptionUpdateEvent.add((eventArgs) =>
      this.onTranscriptionUpdate(eventArgs)
    );
    options.onTranscriptionErrorEvent.add((eventArgs) =>
      this.onTranscriptionError(eventArgs)
    );

    this.asrModule.startTranscribing(options);
  }

  private stopSession(): void {
    this.asrModule.stopTranscribing();

    // Update UI when stopping
    if (this.transcriptionText) {
      this.transcriptionText.text = "Speech recognition stopped";
    }
  }
}
