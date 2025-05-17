// mcp-stdio.js - Model Context Protocol server with stdio transport
import { readFile, readdir, appendFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-3-7-sonnet-20250219';

// Directories where content is stored
// Point to the web-server directories where content is actually stored
const BASE_DIR = path.dirname(new URL(import.meta.url).pathname);
const WEB_SERVER_DIR = path.join(BASE_DIR, '..', 'web-server');
const TRANSCRIPTS_DIR = path.join(WEB_SERVER_DIR, 'transcripts');
const IMAGES_DIR = path.join(WEB_SERVER_DIR, 'images');
const LOGS_DIR = path.join(BASE_DIR, 'logs');

// Ensure logs directory exists
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
}

// Log file paths
const LOG_FILE = path.join(LOGS_DIR, 'mcp-stdio.log');
const ERROR_LOG_FILE = path.join(LOGS_DIR, 'mcp-stdio-error.log');

/**
 * Log message to file with timestamp
 * @param {string} message - Message to log
 * @param {string} [logFile=LOG_FILE] - Path to log file
 */
async function logToFile(message, logFile = LOG_FILE) {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] ${message}\n`;

  try {
    await appendFile(logFile, formattedMessage);
  } catch (err) {
    // If we can't log to file, write to stderr as last resort
    process.stderr.write(`Failed to write to log file ${logFile}: ${err.message}\n`);
  }
}

/**
 * Log error message to error log file
 * @param {string} message - Error message to log
 */
async function logError(message) {
  return logToFile(message, ERROR_LOG_FILE);
}

/**
 * Log message with separator for important content
 * @param {string} title - Section title
 * @param {string} content - Content to log
 */
async function logSection(title, content) {
  await logToFile(`\n===== ${title} =====`);
  await logToFile(content);
  await logToFile('='.repeat(title.length + 12));
}

/**
 * Reads all text files from a directory
 * @param {string} dir - The directory to read from
 * @returns {Promise<Array<{filename: string, content: string}>>}
 */
async function readTextFilesFromDir(dir) {
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
    await logError(`Error reading from ${dir}: ${err.message}`);
    return [];
  }
}

/**
 * Gets a corresponding image for a text file if it exists
 * @param {string} textFilename - The text filename (e.g., "2025-05-17-02-40-24.txt")
 * @returns {Promise<{filepath: string, base64: string, mediaType: string} | null>}
 */
async function getCorrespondingImage(textFilename) {
  try {
    // Extract the timestamp base name
    const baseName = path.basename(textFilename, '.txt');

    // Get all files in the images directory
    const files = await readdir(IMAGES_DIR);

    // Find image files with the same base name
    const imageFile = files.find(file => {
      // Match files with same basename but not .txt extension
      return file.startsWith(baseName) && !file.endsWith('.txt');
    });

    if (!imageFile) return null;

    const filepath = path.join(IMAGES_DIR, imageFile);
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
    await logError(`Error getting corresponding image: ${err.message}`);
    return null;
  }
}

/**
 * Calls Anthropic's API to answer a question based on provided context
 * @param {string} question - The user's question
 * @param {string} context - The context information
 * @returns {Promise<{answer: string, relevantImageTimestamp: string|null}>} - The model's answer and optional relevant image timestamp
 */
async function askAnthropicWithContext(question, context) {
  if (!ANTHROPIC_KEY) {
    throw new Error('Anthropic API key missing (set ANTHROPIC_API_KEY)');
  }

  const promptText = `<context>
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

  // Log the message that will be sent to Claude
  await logSection("PROMPT SENT TO CLAUDE", promptText);

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
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

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API error: ${resp.status} — ${errText}`);
  }

  const data = await resp.json();
  const contentBlock = data?.content?.[0]?.text;

  // Extract the relevant image timestamp if provided
  const imageMatch = contentBlock?.match(/<relevant_image>(.*?)<\/relevant_image>/i);
  const relevantImageTimestamp = imageMatch ? imageMatch[1].trim() : null;

  // Clean up the answer by removing the relevant_image tags if present
  const cleanedAnswer = contentBlock?.replace(/<relevant_image>.*?<\/relevant_image>/i, '').trim() ?? 'No answer provided.';

  // Log the processed response
  const responseLog = `Text answer: ${cleanedAnswer}\nImage timestamp: ${relevantImageTimestamp || "None"}`;
  await logSection("PROCESSED RESPONSE FROM CLAUDE", responseLog);

  return {
    answer: cleanedAnswer,
    relevantImageTimestamp
  };
}

/**
 * The MCP tool implementation - answers questions using all available context
 * @param {object} params - The parameters for this tool
 * @returns {Promise<object>} - The result object with text answer and optional image
 */
async function answerFromContext(params) {
  const { question } = params;

  if (!question || typeof question !== 'string') {
    throw new Error("Missing or invalid 'question' parameter");
  }

  // Get all text content from transcripts and images directories
  const transcriptFiles = await readTextFilesFromDir(TRANSCRIPTS_DIR);
  const imageDescFiles = await readTextFilesFromDir(IMAGES_DIR);

  // Combine all text content with filenames as context
  let contextParts = [];

  // Add transcript files
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

  // Add image description files
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

  // Combine all context
  const fullContext = contextParts.join("\n");

  // Get answer from Claude API
  const { answer, relevantImageTimestamp } = await askAnthropicWithContext(question, fullContext);

  // If Claude identified a relevant image, prepare it first
  let responseContent = [];

  // Add image first to avoid order swapping issues in some clients
  if (relevantImageTimestamp) {
    const image = await getCorrespondingImage(`${relevantImageTimestamp}.txt`);
    if (image) {
      responseContent.push({
        type: "image",
        data: image.base64,
        mimeType: image.mediaType,
        alt: "Relevant image for your query"
      });
    }
  }

  // Then add text answer
  responseContent.push({
    type: "text",
    text: answer
  });

  return { content: responseContent };
}

// Create the MCP server
const server = new McpServer({
  name: "context-query",
  version: "1.0.0",
});

// Register the context_query tool
server.tool(
  "context_query",
  "Retrieves information from user's recorded audio conversations and camera logs",
  {
    question: z.string().describe("Natural language question about the user's recorded conversations or camera footage (e.g., 'What did I discuss yesterday?', 'Show me pictures from my morning walk')")
  },
  async (params) => {
    try {
      return await answerFromContext(params);
    } catch (error) {
      await logError(`Error in context_query: ${error.message}\n${error.stack}`);
      throw error;
    }
  }
);

// Start the server
async function main() {
  try {
    // Initialize the log file with a startup entry
    const startupMessage = "====================================\n" +
                          "MCP STDIO SERVER STARTING\n" +
                          `Timestamp: ${new Date().toISOString()}\n` +
                          "====================================";
    await logToFile(startupMessage);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    await logToFile("MCP Server listening on stdio transport");
    await logToFile("Ready for Claude Desktop connections");
  } catch (error) {
    await logError(`Error during startup: ${error.message}\n${error.stack}`);
    process.exit(1);
  }
}

main().catch(async (error) => {
  try {
    await logError(`Fatal error in main(): ${error.message}\n${error.stack}`);
  } catch {
    // If even logging fails, use stderr as last resort
    process.stderr.write(`Fatal error: ${error.message}\n`);
  } finally {
    process.exit(1);
  }
});
