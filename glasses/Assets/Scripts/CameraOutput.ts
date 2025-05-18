@component
export class CameraOutput extends BaseScriptComponent {
    // Constants
    private static readonly API_ENDPOINT = "http://localhost:3000/media";
    private static readonly OPENAI_API_ENDPOINT = "https://api.openai.com/v1/chat/completions";
    private static readonly OPENAI_MODEL = "gpt-4o-mini";
    private static readonly MIN_CAPTURE_INTERVAL = 1.0;
    
    // Component inputs
    @input
    @hint("The image that displays the camera feed")
    cameraImage: Image;

    @input
    @hint("Text component to display keywords")
    @label("Keywords Text")
    keywordsText: Text;

    @input
    @hint("Time interval between captures in seconds")
    captureInterval: number = 5.0;

    // OpenAI API Key
    private apiKey: string = "FIXME";

    // Modules
    private remoteServiceModule: InternetModule;

    // State
    private isProcessing: boolean = false;
    private lastCaptureTime: number = 0;

    /**
     * Component initialization
     */
    onAwake() {
        this.remoteServiceModule = require("LensStudio:InternetModule");
        this.setupEventHandlers();
    }

    /**
     * Set up event handlers for component
     */
    private setupEventHandlers() {
        // Update handler - check if it's time to capture a new frame
        this.createEvent("UpdateEvent").bind(() => {
            const currentTime = getTime();
            const intervalElapsed = currentTime - this.lastCaptureTime >= this.captureInterval;
            
            if (intervalElapsed && !this.isProcessing) {
                this.lastCaptureTime = currentTime;
                this.captureAndProcessFrame();
            }
        });

        // Start handler - validate inputs and initialize
        this.createEvent("OnStartEvent").bind(() => {
            this.validateInputs();
            
            if (this.keywordsText) {
                this.keywordsText.text = "";
            }
        });
    }

    /**
     * Validate required component inputs
     */
    private validateInputs(): boolean {
        if (!this.cameraImage) {
            print("ERROR: Please assign a camera image in the inspector");
            return false;
        }

        if (!this.keywordsText) {
            print("ERROR: Please assign a text component for keywords display");
            return false;
        }
        
        return true;
    }

    /**
     * Capture and process a camera frame
     */
    private async captureAndProcessFrame() {
        if (this.isProcessing) {
            return;
        }

        try {
            this.isProcessing = true;

            // Access the texture from the image component displaying the camera feed
            const texture = this.cameraImage.mainPass.baseTex;
            if (!texture) {
                print("ERROR: No texture found in the camera image");
                return;
            }

            const base64Image = await this.encodeTextureToBase64(texture);

            // Process in parallel
            await Promise.all([
                this.sendToLocalServer(base64Image),
                this.sendToOpenAI(base64Image)
            ]);
        } catch (error) {
            print("ERROR: " + error);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Encode a texture to base64 string
     */
    private encodeTextureToBase64(texture: Texture): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            Base64.encodeTextureAsync(
                texture,
                (result: string) => resolve(result),
                () => reject("Failed to encode texture"),
                CompressionQuality.LowQuality,
                EncodingType.Jpg
            );
        });
    }

    /**
     * Send image to OpenAI for object detection
     */
    private async sendToOpenAI(base64Image: string) {
        const requestPayload = {
            model: CameraOutput.OPENAI_MODEL,
            messages: [
                {
                    role: "system",
                    content:
                        "You are a visual object detection assistant. " +
                        "Analyze the image and identify the most prominent objects or features. " +
                        "Respond ONLY with a JSON object of format: {\"keywords\": [\"keyword1\", \"keyword2\", ...]}. " +
                        "Provide a maximum of 5 keywords. Keep keywords very short (1-2 words max)."
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Image}`
                            }
                        }
                    ]
                }
            ]
        };

        const request = new Request(CameraOutput.OPENAI_API_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.apiKey}`
            },
            body: JSON.stringify(requestPayload)
        });

        try {
            let response = await this.remoteServiceModule.fetch(request);
            
            if (response.status === 200) {
                let responseData = await response.json();
                this.processOpenAIResponse(responseData);
            } else {
                print("ERROR: API request failed with status " + await (response.text()));
            }
        } catch (error) {
            print("ERROR in API call: " + error);
        }
    }

    /**
     * Process the response from OpenAI
     */
    private processOpenAIResponse(responseData: any) {
        try {
            let contentText = responseData.choices[0].message.content;

            // Extract JSON from the response
            let jsonMatch = contentText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                let keywordsData = JSON.parse(jsonMatch[0]);
                this.updateKeywordsDisplay(keywordsData.keywords);
            } else {
                print("ERROR: Could not extract JSON from response");
                print("Raw response: " + contentText);
            }
        } catch (e) {
            print("ERROR parsing OpenAI response: " + e);
        }
    }

    /**
     * Update the UI with detected keywords
     */
    private updateKeywordsDisplay(keywords: string[]) {
        if (!keywords || !Array.isArray(keywords)) {
            print("ERROR: Invalid keywords data");
            return;
        }

        print("oai keywords: " + keywords.join(", "));

        // Join keywords with commas and update the text component
        this.keywordsText.text = keywords.join(", ");
    }

    /**
     * Send image to local server for processing
     */
    private async sendToLocalServer(base64Image: string) {
        try {
            const localServerPayload = {
                image: base64Image,
                mediaType: "image/jpeg"
            };

            const request = new Request(CameraOutput.API_ENDPOINT, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(localServerPayload)
            });

            // Send without waiting for response
            const response = await this.remoteServiceModule.fetch(request);
            
            if (response.status === 200) {
                print("Successfully sent image to local server");
            } else {
                print("WARNING: Failed to send image to local server, status: " + (await response.text()));
            }
        } catch (error) {
            print("WARNING: Error sending image to local server: " + error);
        }
    }
}