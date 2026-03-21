export type SupportedLanguage = "en" | "pt" | "es";

export type ClaudeModel = "sonnet" | "opus" | "haiku";
export type CodexModel = "gpt-5.4" | "gpt-5.4-mini" | "gpt-5.3-codex" | "gpt-5.2-codex" | "gpt-5.2" | "gpt-5.1-codex-max" | "gpt-5.1-codex-mini";
export type AIModel = ClaudeModel | CodexModel;
export type Provider = "claude" | "codex";

export function getProvider(model: string): Provider {
  return model.startsWith("gpt-") ? "codex" : "claude";
}

export interface ClinkConfig {
  token: string;
  allowedUsers: number[];
  model: AIModel;
  systemPrompt: string;
  workingDir: string;
  skipPermissions: boolean;
  language: SupportedLanguage;
}

export interface SessionEntry {
  sessionId: string;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  fullPath: string;
}

export interface ActiveSessionMap {
  [chatId: string]: string;
}

export interface AgentResult {
  text: string;
  files: string[];
}

export type IntentClassification = "chat" | "action" | "send_file";

export interface PendingApproval {
  chatId: number;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GatewayStatus {
  running: boolean;
  pid: number | null;
}

export interface Messages {
  // Status / labels
  intro: string;
  token: string;
  model: string;
  directory: string;
  users: string;
  permissions: string;
  sysPrompt: string;
  language: string;
  gateway: string;
  configFile: string;
  notConfigured: string;
  allUsers: string;
  autonomous: string;
  askApproval: string;
  none: string;
  configured: string;
  stopped: string;
  running: string;

  // Main menu
  menuTitle: string;
  menuStart: string;
  menuToken: string;
  menuModel: string;
  menuWorkdir: string;
  menuUsers: string;
  menuPermissions: string;
  menuPrompt: string;
  menuLanguage: string;
  menuExit: string;
  ready: string;
  configureTokenFirst: string;
  required: string;
  goodbye: string;

  // Start
  noUsersWarning: string;
  startingGateway: string;
  securityNote: string;

  // Token
  tokenPrompt: string;
  tokenPlaceholder: string;
  tokenRequired: string;
  tokenInvalid: string;
  tokenSaved: string;

  // Model
  modelPrompt: string;
  sonnetHint: string;
  opusHint: string;
  haikuHint: string;
  claudeSection: string;
  codexSection: string;
  codexNotFound: string;
  codexLatestHint: string;
  codexMiniHint: string;
  codexCodingHint: string;

  // Workdir
  workdirPrompt: string;

  // Users
  noUsersConfigured: string;
  userIdHint: string;
  manageUsers: string;
  addUser: string;
  removeUser: string;
  clearAll: string;
  allowAnyone: string;
  back: string;
  userIdPrompt: string;
  userIdPlaceholder: string;
  userIdInvalid: string;
  userAlreadyExists: string;
  removeWhich: string;
  clearConfirm: string;
  listCleared: string;
  listEmpty: string;

  // Permissions
  permCurrentAuto: string;
  permCurrentSafe: string;
  permPrompt: string;
  permAutoLabel: string;
  permAutoHint: string;
  permSafeLabel: string;
  permSafeHint: string;
  permAutoEnabled: string;
  permSafeEnabled: string;
  permAutoNote: string;
  permSafeNote: string;

  // Prompt
  promptMessage: string;
  promptPlaceholder: string;
  promptSaved: string;
  promptRemoved: string;

  // Language
  languagePrompt: string;

  // Security disclaimer
  disclaimerTitle: string;
  disclaimerLine1: string;
  disclaimerLine2: string;
  disclaimerLine3: string;
  disclaimerAsIs: string;
  disclaimerLiability: string;
  disclaimerResponsibility: string;
  disclaimerRec: string;
  disclaimerRec1: string;
  disclaimerRec2: string;
  disclaimerRec3: string;
  disclaimerConfirm: string;
  disclaimerCancelled: string;

  // Wizard
  wizardWelcome: string;
  wizardChecking: string;
  wizardClaudeFound: string;
  wizardClaudeNotFound: string;
  wizardClaudeInstall: string;
  wizardClaudeAuth: string;
  wizardClaudeNotAuth: string;
  wizardLanguage: string;
  wizardTokenIntro: string;
  wizardTokenStep1: string;
  wizardTokenStep2: string;
  wizardTokenStep3: string;
  wizardUserIntro: string;
  wizardUserHow: string;
  wizardUserSkip: string;
  wizardModelIntro: string;
  wizardDone: string;
  wizardReady: string;
  wizardStartNow: string;

  // Sessions & Commands
  sessionCleared: string;
  cmdNewDesc: string;
  cmdStatusDesc: string;
  botWelcome: string;
  messagesInSession: string;
  uptime: string;
  sessionNone: string;
  sessionRetry: string;
  cmdSessionsDesc: string;
  sessionsTitle: string;
  noSessions: string;
  sessionResumed: string;
  sessionResumedLong: string;
  sessionNotFound: string;

  // Telegram permissions
  permTitle: string;
  permAllow: string;
  permDeny: string;
  permAllowed: string;
  permDenied: string;
  permExpired: string;
  permTimedOut: string;
  permApprovalHint: string;

  // Send command
  sendPrompt: string;
  sendChooseAction: string;
  sendTextOption: string;
  sendFileOption: string;
  sendText: string;
  sendFilePath: string;
  sendFilePathPlaceholder: string;
  sendCaption: string;
  sendCaptionPlaceholder: string;
  sendSuccess: string;
  sendNoUsers: string;
  sendChooseUser: string;
  sendSending: string;
  sendInvalidChatId: string;

  // Errors
  tokenNotConfigured: string;
  toConfigure: string;

  // Gateway
  gatewayStarted: string;
  gatewayModel: string;
  gatewayDirectory: string;
  gatewayPermissions: string;
  gatewayAllowed: string;
  gatewayWaiting: string;
  noResponse: string;

  // Audio transcription
  audioTranscribing: string;
  audioTranscription: string;
  audioConversionFailed: string;
  audioTranscriptionFailed: string;

  // Function properties
  userCount: (n: number) => string;
  modelChanged: (m: string) => string;
  workdirNotFound: (d: string) => string;
  workdirChanged: (d: string) => string;
  currentUsers: (u: string) => string;
  userAdded: (id: string | number) => string;
  userRemoved: (id: number) => string;
  languageChanged: (l: string) => string;
  wizardClaudeVersion: (v: string) => string;
  wizardStep: (n: number, total: number) => string;
  sessionInfo: (id: string, count: number) => string;
  sendFileNotFound: (f: string) => string;
  sendToFailed: (id: number) => string;
  gatewayBlocked: (id: number, user: string) => string;

  // Optional
  fileNotDelivered?: string;
}
