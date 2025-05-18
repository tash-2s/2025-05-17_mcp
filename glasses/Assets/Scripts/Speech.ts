@component
export class Speech extends BaseScriptComponent {
  // Constants
  private static readonly API_ENDPOINT = "http://localhost:3000/media";
  private static readonly MIN_TRANSCRIPT_LENGTH = 5;
  private static readonly SILENCE_DURATION_MS = 2000; // 2 seconds

  // Component inputs
  @input
  @hint("Text component to display transcription")
  @label("Transcription Text")
  transcriptionText: Text;

  // Modules
  private asrModule = require('LensStudio:AsrModule');
  private remoteServiceModule = require("LensStudio:InternetModule");

  /**
   * Component initialization
   */
  onAwake(): void {
    this.initializeTranscription();
  }

  /**
   * Initialize speech transcription
   */
  private initializeTranscription(): void {
    // Initialize text component
    if (this.transcriptionText) {
      this.transcriptionText.text = "Listening...";
    } else {
      print("ERROR: Please assign a text component for transcription display");
      return;
    }

    // Configure ASR options
    const options = this.createTranscriptionOptions();
    
    // Start transcribing
    this.asrModule.startTranscribing(options);
  }

  /**
   * Create ASR transcription options with event handlers
   */
  private createTranscriptionOptions(): AsrModule.AsrTranscriptionOptions {
    const options = AsrModule.AsrTranscriptionOptions.create();
    
    // Increase silence duration to allow for better sentence completion
    options.silenceUntilTerminationMs = Speech.SILENCE_DURATION_MS;
    options.mode = AsrModule.AsrMode.HighAccuracy;
    
    // Register event handlers
    options.onTranscriptionUpdateEvent.add((eventArgs) => 
      this.onTranscriptionUpdate(eventArgs)
    );
    options.onTranscriptionErrorEvent.add((eventArgs) => 
      this.onTranscriptionError(eventArgs)
    );
    
    return options;
  }

  /**
   * Handle transcription updates
   */
  private onTranscriptionUpdate(eventArgs: AsrModule.TranscriptionUpdateEvent) {
    // Update the UI text component with transcription
    if (this.transcriptionText) {
      this.transcriptionText.text = eventArgs.text;
    }

    // Debug logging
    print(
      `onTranscriptionUpdateCallback text=${eventArgs.text}, isFinal=${eventArgs.isFinal}`
    );

    // Send final transcription to local server if it has sufficient length
    if (eventArgs.isFinal) {
      const transcriptText = eventArgs.text.trim();
      
      if (transcriptText.length >= Speech.MIN_TRANSCRIPT_LENGTH) {
        this.sendTranscriptionToLocalServer(transcriptText);
        print(`Sending final transcription to server: "${transcriptText}"`);
      } else {
        print(`Ignoring short transcription (< ${Speech.MIN_TRANSCRIPT_LENGTH} chars): "${transcriptText}"`);
      }
    }
  }

  /**
   * Handle transcription errors
   */
  private onTranscriptionError(errorCode: AsrModule.AsrStatusCode) {
    print(`onTranscriptionErrorCallback errorCode: ${errorCode}`);

    const errorMessage = this.getErrorMessage(errorCode);
    
    // Show error message in the text component
    if (this.transcriptionText && errorMessage) {
      this.transcriptionText.text = "Error: " + errorMessage;
    }
  }

  /**
   * Get user-friendly error message from error code
   */
  private getErrorMessage(errorCode: AsrModule.AsrStatusCode): string {
    switch (errorCode) {
      case AsrModule.AsrStatusCode.InternalError:
        print('stopTranscribing: Internal Error');
        return 'Internal Error';
      
      case AsrModule.AsrStatusCode.Unauthenticated:
        print('stopTranscribing: Unauthenticated');
        return 'Unauthenticated';
      
      case AsrModule.AsrStatusCode.NoInternet:
        print('stopTranscribing: No Internet');
        return 'No Internet Connection';
      
      default:
        return `Unknown Error (${errorCode})`;
    }
  }

  /**
   * Send transcription to local server
   */
  private sendTranscriptionToLocalServer(transcript: string) {
    try {
      const payload = {
        transcript: transcript
      };

      const request = new Request(Speech.API_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      // Send request
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

  /**
   * Stop transcription session
   */
  private stopSession(): void {
    this.asrModule.stopTranscribing();

    // Update UI when stopping
    if (this.transcriptionText) {
      this.transcriptionText.text = "Speech recognition stopped";
    }
  }
}