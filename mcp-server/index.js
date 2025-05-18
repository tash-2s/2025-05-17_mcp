// mcp-stdio.js - Model Context Protocol server with stdio transport
import { readFile, readdir, appendFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // API configuration
  api: {
    anthropic: {
      key: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL ?? 'claude-3-7-sonnet-20250219',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      apiVersion: '2023-06-01'
    }
  },
  // Content limits
  limits: {
    maxTokens: 1024
  },
  // Directories
  paths: {
    base: path.dirname(new URL(import.meta.url).pathname),
    get webServer() { return path.join(this.base, '..', 'web-server'); },
    get transcripts() { return path.join(this.webServer, 'transcripts'); },
    get images() { return path.join(this.webServer, 'images'); },
    get logs() { return path.join(this.base, 'logs'); },
    get logFile() { return path.join(this.logs, 'mcp-stdio.log'); },
    get errorLogFile() { return path.join(this.logs, 'mcp-stdio-error.log'); }
  }
};

// ============================================================================
// Logging Services
// ============================================================================

class Logger {
  static async initialize() {
    // Ensure logs directory exists
    if (!existsSync(CONFIG.paths.logs)) {
      mkdirSync(CONFIG.paths.logs, { recursive: true });
    }
  }

  static async logToFile(message, logFile = CONFIG.paths.logFile) {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] ${message}\n`;

    try {
      await appendFile(logFile, formattedMessage);
    } catch (err) {
      // If we can't log to file, write to stderr as last resort
      process.stderr.write(`Failed to write to log file ${logFile}: ${err.message}\n`);
    }
  }

  static async logError(message) {
    return this.logToFile(message, CONFIG.paths.errorLogFile);
  }

  static async logSection(title, content) {
    await this.logToFile(`\n===== ${title} =====`);
    await this.logToFile(content);
    await this.logToFile('='.repeat(title.length + 12));
  }
}

// ============================================================================
// File System Services
// ============================================================================

class FileService {
  static async readTextFilesFromDir(dir) {
    try {
      const files = await readdir(dir);
      const textFiles = files.filter(file => file.endsWith('.txt'));
  
      // Sort files by timestamp (which is the filename without extension)
      // This ensures consistent ordering based on when the files were created
      textFiles.sort((a, b) => {
        const timestampA = a.replace('.txt', '');
        const timestampB = b.replace('.txt', '');
        return timestampA.localeCompare(timestampB);
      });
  
      const fileContents = await Promise.all(
        textFiles.map(async (filename) => {
          const filepath = path.join(dir, filename);
          const content = await readFile(filepath, 'utf8');
          return { filename, content };
        })
      );
  
      return fileContents;
    } catch (err) {
      await Logger.logError(`Error reading from ${dir}: ${err.message}`);
      return [];
    }
  }

  static async getCorrespondingImage(textFilename) {
    try {
      // Extract the timestamp base name
      const baseName = path.basename(textFilename, '.txt');
  
      // Get all files in the images directory
      const files = await readdir(CONFIG.paths.images);
  
      // Find image files with the same base name
      const imageFile = files.find(file => {
        // Match files with same basename but not .txt extension
        return file.startsWith(baseName) && !file.endsWith('.txt');
      });
  
      if (!imageFile) return null;
  
      const filepath = path.join(CONFIG.paths.images, imageFile);
      const imageBuffer = await readFile(filepath);
      const base64 = imageBuffer.toString('base64');
  
      // Determine media type from extension
      const ext = path.extname(imageFile).toLowerCase().substring(1);
      const mediaType = ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'png'
          ? 'image/png'
          : `image/${ext}`;
  
      return { filepath, base64, mediaType };
    } catch (err) {
      await Logger.logError(`Error getting corresponding image: ${err.message}`);
      return null;
    }
  }
}

// ============================================================================
// AI Services
// ============================================================================

class AnthropicService {
  static async askWithContext(question, context) {
    if (!CONFIG.api.anthropic.key) {
      throw new Error('Anthropic API key missing (set ANTHROPIC_API_KEY)');
    }

    const promptText = this.constructPrompt(question, context);
    
    // Log the message that will be sent to Claude
    await Logger.logSection("PROMPT SENT TO CLAUDE", promptText);

    const requestBody = this.createRequestBody(promptText);
    const response = await this.callAnthropicAPI(requestBody);
    
    return this.processResponse(response);
  }

  static constructPrompt(question, context) {
    return `<context>
${context}
</context>

<instructions>
You are an AI assistant specialized in analyzing and retrieving information from timestamped transcripts and image descriptions.

Based on the information provided in the <context> tag, please answer the question below. Follow these guidelines:

1. Always provide a complete text answer to the question, explaining what you found in the context.
2. Prioritize more recent information (files with more recent timestamps) when relevant.
3. If one image is particularly relevant to answering this question, specify its timestamp using <relevant_image>timestamp</relevant_image> tags AFTER your complete answer.
</instructions>

<question>
${question}
</question>`;
  }

  static createRequestBody(promptText) {
    return {
      model: CONFIG.api.anthropic.model,
      max_tokens: CONFIG.limits.maxTokens,
      temperature: 0.1, // More deterministic responses
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: promptText
            }
          ]
        }
      ]
    };
  }

  static async callAnthropicAPI(body) {
    const resp = await fetch(CONFIG.api.anthropic.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': CONFIG.api.anthropic.key,
        'anthropic-version': CONFIG.api.anthropic.apiVersion,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Anthropic API error: ${resp.status} — ${errText}`);
    }

    return await resp.json();
  }

  static async processResponse(data) {
    const contentBlock = data?.content?.[0]?.text;

    // Extract the relevant image timestamp if provided
    const imageMatch = contentBlock?.match(/<relevant_image>(.*?)<\/relevant_image>/i);
    const relevantImageTimestamp = imageMatch ? imageMatch[1].trim() : null;

    // Clean up the answer by removing the relevant_image tags if present
    const cleanedAnswer = contentBlock?.replace(/<relevant_image>.*?<\/relevant_image>/i, '').trim() ?? 'No answer provided.';

    // Log the processed response
    const responseLog = `Text answer: ${cleanedAnswer}\nImage timestamp: ${relevantImageTimestamp || "None"}`;
    await Logger.logSection("PROCESSED RESPONSE FROM CLAUDE", responseLog);

    return {
      answer: cleanedAnswer,
      relevantImageTimestamp
    };
  }
}

// ============================================================================
// Context Builder
// ============================================================================

class ContextBuilder {
  static async buildFullContext() {
    // Get all text content from transcripts and images directories
    const transcriptFiles = await FileService.readTextFilesFromDir(CONFIG.paths.transcripts);
    const imageDescFiles = await FileService.readTextFilesFromDir(CONFIG.paths.images);

    // Combine all text content with filenames as context
    let contextParts = [];

    this.addTranscriptsToContext(contextParts, transcriptFiles);
    this.addImageDescriptionsToContext(contextParts, imageDescFiles);

    // Combine all context
    return contextParts.join("\n");
  }

  static addTranscriptsToContext(contextParts, transcriptFiles) {
    if (transcriptFiles.length > 0) {
      contextParts.push("<transcripts>");
      transcriptFiles.forEach(({ filename, content }) => {
        // Extract timestamp from filename
        const timestamp = filename.replace('.txt', '');

        contextParts.push(`<transcript timestamp="${timestamp}">`);
        contextParts.push(`\n${content}\n`);
        contextParts.push("</transcript>");
      });
      contextParts.push("</transcripts>");
    }
  }

  static addImageDescriptionsToContext(contextParts, imageDescFiles) {
    if (imageDescFiles.length > 0) {
      contextParts.push("<image_descriptions>");

      for (const { filename, content } of imageDescFiles) {
        // Extract timestamp from filename
        const timestamp = filename.replace('.txt', '');

        contextParts.push(`<image_description timestamp="${timestamp}">`);
        contextParts.push(`\n${content}\n`);
        contextParts.push("</image_description>");
      }
      contextParts.push("</image_descriptions>");
    }
  }
}

// ============================================================================
// Response Builder
// ============================================================================

class ResponseBuilder {
  static async buildResponse(answer, relevantImageTimestamp) {
    let responseContent = [];

    // Add image first to avoid order swapping issues in some clients
    await this.addImageIfRelevant(responseContent, relevantImageTimestamp);
    
    // Then add text answer
    responseContent.push({
      type: "text",
      text: answer
    });

    return { content: responseContent };
  }

  static async addImageIfRelevant(responseContent, relevantImageTimestamp) {
    if (relevantImageTimestamp) {
      const image = await FileService.getCorrespondingImage(`${relevantImageTimestamp}.txt`);
      if (image) {
        responseContent.push({
          type: "image",
          data: image.base64,
          mimeType: image.mediaType,
          alt: "Relevant image for your query"
        });
      }
    }
  }
}

// ============================================================================
// MCP Tool Implementation
// ============================================================================

class QueryService {
  static async answerFromContext(params) {
    const { question } = params;

    if (!question || typeof question !== 'string') {
      throw new Error("Missing or invalid 'question' parameter");
    }

    // Build context from files
    const fullContext = await ContextBuilder.buildFullContext();

    // Get answer from Claude API
    const { answer, relevantImageTimestamp } = await AnthropicService.askWithContext(question, fullContext);

    // Build response with text and optional image
    return ResponseBuilder.buildResponse(answer, relevantImageTimestamp);
  }
}

// ============================================================================
// Server Setup
// ============================================================================

class MCPServer {
  constructor() {
    this.server = new McpServer({
      name: "context-query",
      version: "1.0.0",
    });
  }

  registerTools() {
    this.server.tool(
      "context_query",
      "Retrieves information from user's recorded audio conversations and camera logs",
      {
        question: z.string().describe("Natural language question about the user's recorded conversations or camera footage (e.g., 'What did I discuss yesterday?', 'Show me pictures from my morning walk')")
      },
      async (params) => {
        try {
          return await QueryService.answerFromContext(params);
        } catch (error) {
          await Logger.logError(`Error in context_query: ${error.message}\n${error.stack}`);
          throw error;
        }
      }
    );
  }

  async start() {
    try {
      // Initialize the log file with a startup entry
      const startupMessage = "====================================\n" +
                            "MCP STDIO SERVER STARTING\n" +
                            `Timestamp: ${new Date().toISOString()}\n` +
                            "====================================";
      await Logger.logToFile(startupMessage);

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      await Logger.logToFile("MCP Server listening on stdio transport");
      await Logger.logToFile("Ready for Claude Desktop connections");
    } catch (error) {
      await Logger.logError(`Error during startup: ${error.message}\n${error.stack}`);
      process.exit(1);
    }
  }
}

// ============================================================================
// Application Entry Point
// ============================================================================

async function main() {
  try {
    // Initialize logging
    await Logger.initialize();
    
    // Create and start server
    const server = new MCPServer();
    server.registerTools();
    await server.start();
  } catch (error) {
    try {
      await Logger.logError(`Fatal error in main(): ${error.message}\n${error.stack}`);
    } catch {
      // If even logging fails, use stderr as last resort
      process.stderr.write(`Fatal error: ${error.message}\n`);
    } finally {
      process.exit(1);
    }
  }
}

main();