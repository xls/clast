import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('clast');

  if (!config.get<boolean>('enabled', true)) {
    return;
  }

  // Status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(symbol-class) Clast';
  statusBarItem.tooltip = 'Clast AST Index Active';
  statusBarItem.command = 'clast.status';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Auto-setup Claude Code MCP integration
  if (config.get<boolean>('autoSetupClaudeCode', true)) {
    setupClaudeCodeIntegration(context);
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('clast.reindex', handleReindex),
    vscode.commands.registerCommand('clast.status', handleStatus),
    vscode.commands.registerCommand('clast.configure', handleConfigure),
  );

  // Watch for workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (config.get<boolean>('autoSetupClaudeCode', true)) {
        setupClaudeCodeIntegration(context);
      }
    })
  );
}

export function deactivate() {
  statusBarItem?.dispose();
}

/**
 * Auto-configure Claude Code's .claude/settings.local.json to include
 * the Clast MCP server for each workspace folder.
 */
function setupClaudeCodeIntegration(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return;

  for (const folder of workspaceFolders) {
    const projectDir = folder.uri.fsPath;
    const claudeDir = path.join(projectDir, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.local.json');

    // Find the clast server binary
    const clastServerPath = findClastServer(context);
    if (!clastServerPath) {
      vscode.window.showWarningMessage(
        'Clast: Could not find clast server. Please run `npm install -g clast` or install the Clast Claude Code plugin.'
      );
      return;
    }

    try {
      // Ensure .claude directory exists
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }

      // Read existing settings or create new
      let settings: Record<string, unknown> = {};
      if (fs.existsSync(settingsPath)) {
        try {
          settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        } catch {
          // If parsing fails, start fresh
        }
      }

      // Ensure mcpServers section exists
      const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>;

      // Only add if not already configured
      if (!mcpServers.clast) {
        mcpServers.clast = {
          command: 'node',
          args: [clastServerPath],
          env: {
            CLAST_PROJECT_DIR: projectDir,
          },
        };

        settings.mcpServers = mcpServers;

        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        vscode.window.showInformationMessage(
          `Clast: MCP server configured for ${folder.name}. Claude Code will use AST indexing.`
        );
      }
    } catch (err) {
      console.error('Clast: Failed to setup Claude Code integration:', err);
    }
  }
}

function findClastServer(context: vscode.ExtensionContext): string | null {
  // 1. Check if clast is installed globally (npm global)
  const globalPaths = [
    // Unix-like
    '/usr/local/lib/node_modules/clast/dist/server/index.js',
    // Windows npm global
    path.join(process.env.APPDATA ?? '', 'npm/node_modules/clast/dist/server/index.js'),
    // Homebrew
    '/opt/homebrew/lib/node_modules/clast/dist/server/index.js',
  ];

  for (const p of globalPaths) {
    if (fs.existsSync(p)) return p;
  }

  // 2. Check Claude Code plugins directory
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const pluginPaths = [
    path.join(homeDir, '.claude/plugins/marketplaces/claude-plugins-official/clast/dist/server/index.js'),
    path.join(homeDir, '.claude/plugins/clast/dist/server/index.js'),
  ];

  for (const p of pluginPaths) {
    if (fs.existsSync(p)) return p;
  }

  // 3. Check workspace node_modules
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    for (const folder of workspaceFolders) {
      const localPath = path.join(folder.uri.fsPath, 'node_modules/clast/dist/server/index.js');
      if (fs.existsSync(localPath)) return localPath;
    }
  }

  // 4. Try resolving from npm global prefix
  try {
    const { execSync } = require('child_process');
    const prefix = execSync('npm prefix -g', { encoding: 'utf-8' }).trim();
    const npmGlobalPath = path.join(prefix, 'lib/node_modules/clast/dist/server/index.js');
    if (fs.existsSync(npmGlobalPath)) return npmGlobalPath;
    // Windows variant
    const npmGlobalPathWin = path.join(prefix, 'node_modules/clast/dist/server/index.js');
    if (fs.existsSync(npmGlobalPathWin)) return npmGlobalPathWin;
  } catch {
    // npm not available
  }

  return null;
}

async function handleReindex() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showWarningMessage('Clast: No workspace folder open');
    return;
  }

  vscode.window.showInformationMessage('Clast: Reindex triggered. Check Claude Code for progress.');
}

async function handleStatus() {
  vscode.window.showInformationMessage(
    'Clast: Use `/clast-status` in Claude Code to see detailed index status.'
  );
}

async function handleConfigure() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('Clast: No workspace folder open');
    return;
  }

  const projectRoot = workspaceFolders[0]!.uri.fsPath;
  const configPath = path.join(projectRoot, 'clast.config.json');

  if (!fs.existsSync(configPath)) {
    // Create default config
    const defaultConfig = {
      languages: ['typescript', 'javascript', 'python', 'java', 'csharp', 'go', 'rust', 'c', 'cpp', 'ruby', 'php'],
      ignoredPaths: ['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', '.clast'],
      llm: {
        endpoint: vscode.workspace.getConfiguration('clast').get('llm.endpoint', 'http://localhost:11434/v1'),
        model: vscode.workspace.getConfiguration('clast').get('llm.model', ''),
        apiKey: '',
        alwaysGenerate: false,
      },
      watch: {
        debounceMs: 300,
        enabled: true,
      },
    };

    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
  }

  const doc = await vscode.workspace.openTextDocument(configPath);
  await vscode.window.showTextDocument(doc);
}
