import type {
  DialogPluginSettings,
  DialogRuntimeState,
  HomePinnedCommandSetting,
  ModelConfigRecord,
  ModelPreset,
  ModelProviderId,
  ModelProviderPreset,
  WebSearchMode
} from "./types";

export const PLUGIN_ID = "sidet";
export const PLUGIN_NAME = "Sidet";
export const PLUGIN_AUTHOR = "Jiao Yingxing";

export const BROWSER_VIEW_TYPE = "sidet-browser-view";
export const CHAT_VIEW_TYPE = "sidet-chat-view";
export const CHAT_VIEW_ICON = "message-circle";

export const SILICONFLOW_SECRET_ID = "sidet-siliconflow-api-key";
export const PLUGIN_DATA_DIR = `.obsidian/plugins/${PLUGIN_ID}`;
export const THREADS_DIR = `${PLUGIN_DATA_DIR}/threads`;
export const FOLDERS_FILE = `${PLUGIN_DATA_DIR}/folders.json`;
export const DEFAULT_HOME_ACTION_COMMAND_ID = "workspace:new-tab";
export const HOME_PINNED_COMMAND_LIMIT = 8;

export const DEFAULT_MODEL_PROVIDER_ID: ModelProviderId = "siliconflow";
export const DEFAULT_MODEL_PRESET_ID = "siliconflow-deepseek-v3";
export const CUSTOM_MODEL_PRESET_ID = "custom";
export const DEFAULT_MODEL_CONFIG_ID = "model-default";
export const DEFAULT_WEB_SEARCH_MODE: WebSearchMode = "off";

export const MODEL_PROVIDER_PRESETS: ModelProviderPreset[] = [
  {
    id: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3"
  },
  {
    id: "mimo",
    label: "小米 MiMo",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    defaultModel: "mimo-v2.5-pro",
    supportsReasoning: true
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat"
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/auto"
  },
  {
    id: "custom",
    label: "自定义 OpenAI 兼容",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "deepseek-ai/DeepSeek-V3"
  }
];

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "siliconflow-deepseek-v3",
    label: "DeepSeek-V3（硅基流动）",
    providerId: "siliconflow",
    model: "deepseek-ai/DeepSeek-V3",
    baseUrl: "https://api.siliconflow.cn/v1"
  },
  {
    id: "siliconflow-deepseek-r1",
    label: "DeepSeek-R1（硅基流动）",
    providerId: "siliconflow",
    model: "deepseek-ai/DeepSeek-R1",
    baseUrl: "https://api.siliconflow.cn/v1"
  },
  {
    id: "mimo-v25-pro",
    label: "MiMo-V2.5-Pro（小米 MiMo）",
    providerId: "mimo",
    model: "mimo-v2.5-pro",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1"
  },
  {
    id: "mimo-v25",
    label: "MiMo-V2.5（小米 MiMo）",
    providerId: "mimo",
    model: "mimo-v2.5",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    supportsImageInput: true
  },
  {
    id: "openai-gpt-4o",
    label: "GPT-4o（OpenAI）",
    providerId: "openai",
    model: "gpt-4o",
    baseUrl: "https://api.openai.com/v1"
  },
  {
    id: "deepseek-chat",
    label: "DeepSeek Chat（DeepSeek）",
    providerId: "deepseek",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1"
  },
  {
    id: "openrouter-auto",
    label: "Auto（OpenRouter）",
    providerId: "openrouter",
    model: "openrouter/auto",
    baseUrl: "https://openrouter.ai/api/v1"
  }
];

export const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V3";
export const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
export const DEFAULT_MODEL_CONFIG: ModelConfigRecord = {
  id: DEFAULT_MODEL_CONFIG_ID,
  name: DEFAULT_MODEL,
  providerId: DEFAULT_MODEL_PROVIDER_ID,
  providerLabel: "硅基流动",
  presetId: DEFAULT_MODEL_PRESET_ID,
  model: DEFAULT_MODEL,
  baseUrl: DEFAULT_BASE_URL,
  reasoningEnabled: false,
  reasoningCompatibilityMode: "none"
};
export const DEFAULT_EXPORT_FOLDER = "Sidet/chat";
export const DEFAULT_AGENT_DRAFT_FOLDER = "Sidet/Drafts";
export const DEFAULT_AGENT_MEMORY_FOLDER = "Sidet/Memory";
export const DEFAULT_AGENT_WIKI_FOLDER = "Sidet/Wiki";
export const DEFAULT_AGENT_SKILL_FOLDER = "Sidet/Skills";
export const DEFAULT_WEB_CLIPPING_FOLDER = "Sidet/Web Clippings";
export const ALL_KNOWLEDGE_BASES_SELECTION = "__sidet_all_knowledge_bases__";
export const ALL_KNOWLEDGE_BASES_DISPLAY_NAME = "全部知识库";
export const UNTITLED_CONVERSATION_TITLE = "新对话";
export const STORAGE_DEBOUNCE_MS = 320;
export const MAX_NOTE_CONTEXT_CHARS = 12000;
export const MAX_SELECTION_CONTEXT_CHARS = 6000;
export const MAX_MARKDOWN_ATTACHMENT_CONTEXT_CHARS = 6000;
export const MAX_AGENT_CONTEXT_CHARS = 10000;
export const MAX_AGENT_ROUTER_CONTEXT_CHARS = 6000;
export const MAX_AGENT_BUILT_IN_SKILLS = 3;
export const MAX_AGENT_USER_SKILLS = 4;
export const MAX_AGENT_WIKI_MEMORY_RESULTS = 3;
export const MAX_AGENT_WIKI_MEMORY_EXCERPT_CHARS = 900;
export const MAX_AGENT_WIKI_OUTLINE_ITEMS = 6;
export const MAX_AGENT_WIKI_RELATED_LINKS = 8;

export const DEFAULT_HOME_PINNED_COMMANDS: HomePinnedCommandSetting[] = [
  {
    commandId: DEFAULT_HOME_ACTION_COMMAND_ID,
    labelOverride: "",
    iconOverride: ""
  }
];
export const URL_LAUNCHER_LIMIT = HOME_PINNED_COMMAND_LIMIT;
export const SIDET_OPEN_CHAT_ACTION = "open-chat";
export const SIDET_URL_LAUNCH_ACTION = "sidet-launch";

export const DEFAULT_SETTINGS: DialogPluginSettings = {
  modelConfigs: [
    {
      ...DEFAULT_MODEL_CONFIG
    }
  ],
  defaultModelConfigId: DEFAULT_MODEL_CONFIG_ID,
  webSearchMode: DEFAULT_WEB_SEARCH_MODE,
  exportFolder: DEFAULT_EXPORT_FOLDER,
  homePinnedCommands: DEFAULT_HOME_PINNED_COMMANDS,
  urlLaunchers: []
};

export const DEFAULT_RUNTIME_STATE: DialogRuntimeState = {};
