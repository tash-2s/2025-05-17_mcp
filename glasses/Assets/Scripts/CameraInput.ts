@component
export class CameraInput extends BaseScriptComponent {
  // Module references
  private cameraModule: CameraModule = require("LensStudio:CameraModule");
  
  // Camera components
  private cameraRequest: CameraModule.CameraRequest;
  private cameraTexture: Texture;
  private cameraTextureProvider: CameraTextureProvider;

  // Component inputs
  @input
  @hint("The image in the scene that will be showing the captured frame.")
  uiImage: Image | undefined;

  /**
   * Initialize the camera on component awake
   */
  onAwake() {
    // Set up camera initialization on start
    this.createEvent("OnStartEvent").bind(() => this.initializeCamera());
  }

  /**
   * Initialize camera and set up frame capture
   */
  private initializeCamera() {
    // Create camera request
    this.cameraRequest = CameraModule.createCameraRequest();
    this.cameraRequest.cameraId = CameraModule.CameraId.Default_Color;

    // Request camera access
    this.cameraTexture = this.cameraModule.requestCamera(this.cameraRequest);
    this.cameraTextureProvider = this.cameraTexture.control as CameraTextureProvider;

    // Set up frame capture handler
    this.cameraTextureProvider.onNewFrame.add((cameraFrame) => this.onCameraFrame());
  }

  /**
   * Handle new camera frames
   */
  private onCameraFrame() {
    // Update UI image with camera texture if available
    if (this.uiImage) {
      this.uiImage.mainPass.baseTex = this.cameraTexture;
    }
  }
}