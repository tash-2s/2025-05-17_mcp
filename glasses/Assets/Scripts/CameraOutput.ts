@component
export class CameraOutput extends BaseScriptComponent {
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

    onAwake() {
        this.remoteServiceModule = require("LensStudio:InternetModule");

        // Set up events
        this.createEvent("UpdateEvent").bind(() => {
            const currentTime = getTime();

            // Check if it's time to capture
            if (currentTime - this.lastCaptureTime >= this.captureInterval && !this.isProcessing) {
                this.lastCaptureTime = currentTime;
                this.captureAndProcessFrame();
            }
        });

        this.createEvent("OnStartEvent").bind(() => {
            // Verify inputs
            if (!this.cameraImage) {
                print("ERROR: Please assign a camera image in the inspector");
                return;
            }

            if (!this.keywordsText) {
                print("ERROR: Please assign a text component for keywords display");
                return;
            }

            // Initialize keywords text to empty
            this.keywordsText.text = "";
        });
    }

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

            // Send to local server without waiting for it
            this.sendToLocalServer(base64Image);

            // Only wait for OpenAI response
            await this.sendToOpenAI(base64Image);
        } catch (error) {
            print("ERROR: " + error);
        } finally {
            this.isProcessing = false;
        }
    }

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

    private async sendToOpenAI(base64Image: string) {
        const requestPayload = {
            model: "gpt-4o-mini",
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

        const request = new Request("https://api.openai.com/v1/chat/completions", {
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
                let contentText = responseData.choices[0].message.content;

                // Extract JSON from the response
                let jsonMatch = contentText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    try {
                        let keywordsData = JSON.parse(jsonMatch[0]);
                        this.updateKeywordsDisplay(keywordsData.keywords);
                    } catch (e) {
                        print("ERROR parsing JSON response: " + e);
                        print("Raw response: " + contentText);
                    }
                } else {
                    print("ERROR: Could not extract JSON from response");
                    print("Raw response: " + contentText);
                }
            } else {
                print("ERROR: API request failed with status " + await (response.text()));
            }
        } catch (error) {
            print("ERROR in API call: " + error);
        }
    }

    private updateKeywordsDisplay(keywords: string[]) {
        if (!keywords || !Array.isArray(keywords)) {
            print("ERROR: Invalid keywords data");
            return;
        }

        print("oai keywords: " + keywords.join(", "));

        // Join keywords with commas and update the text component
        this.keywordsText.text = keywords.join(", ");
    }

    private sendToLocalServer(base64Image: string) {
        try {
            const localServerPayload = {
                image: base64Image,
                mediaType: "image/jpeg"
            };

            const request = new Request("http://localhost:3000/media", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(localServerPayload)
            });

            // Send without waiting for response
            this.remoteServiceModule.fetch(request)
                .then(async (response) => {
                    if (response.status === 200) {
                        print("Successfully sent image to local server");
                    } else {
                        print("WARNING: Failed to send image to local server, status: " + (await response.text()));
                    }
                })
                .catch(error => {
                    print("WARNING: Error sending image to local server: " + error);
                });
        } catch (error) {
            print("WARNING: Error preparing local server request: " + error);
        }
    }
}
