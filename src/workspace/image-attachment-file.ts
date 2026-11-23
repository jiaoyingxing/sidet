import { Platform } from "obsidian";
import { makeId } from "../shared/paths";
import type { ImageMessageAttachment } from "../types";

export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export const SUPPORTED_IMAGE_EXTENSIONS = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"]
]);

interface ElectronOpenDialog {
  showOpenDialogSync?: (options: {
    title?: string;
    properties?: string[];
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => string[] | undefined;
}

type RuntimeRequire = (moduleName: string) => unknown;

interface DesktopNodeFileApi {
  fs: {
    readFile: (filePath: string) => Promise<Buffer>;
  };
  path: {
    basename: (filePath: string) => string;
    extname: (filePath: string) => string;
  };
}

interface DesktopImagePathSelection {
  handled: boolean;
  filePath?: string;
}

export function createHiddenImageInput(
  parentEl: HTMLElement,
  onSelect: (file: File) => void,
  onCancel: () => void
): HTMLInputElement {
  const inputEl = parentEl.createEl("input");
  inputEl.type = "file";
  inputEl.accept = "image/*";
  inputEl.multiple = false;
  inputEl.tabIndex = -1;
  inputEl.setAttr("aria-hidden", "true");
  inputEl.setCssProps({
    position: "fixed",
    left: "-10000px",
    top: "-10000px",
    width: "1px",
    height: "1px",
    opacity: "0"
  });
  inputEl.addEventListener("change", () => {
    const file = inputEl.files?.[0];
    if (!file) {
      onCancel();
      return;
    }
    onSelect(file);
  });
  inputEl.addEventListener("cancel", onCancel);
  return inputEl;
}

export function pickDesktopImagePath(): DesktopImagePathSelection {
  if (!Platform.isDesktopApp) {
    return { handled: false };
  }
  const dialog = getElectronOpenDialog();
  if (!dialog?.showOpenDialogSync) {
    return { handled: false };
  }

  const selectedPaths = dialog.showOpenDialogSync({
    title: "选择图片",
    properties: ["openFile"],
    filters: [
      {
        name: "图片",
        extensions: ["jpg", "jpeg", "png", "webp", "gif"]
      }
    ]
  });
  const selectedPath = selectedPaths?.[0];
  return selectedPath ? { handled: true, filePath: selectedPath } : { handled: true };
}

export async function createImageAttachmentFromFile(file: File): Promise<ImageMessageAttachment> {
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(file.type)) {
    throw new Error("当前只支持 JPG、PNG、WebP 或 GIF 图片。");
  }
  if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error("图片不能超过 5MB。");
  }

  const dataUrl = await readFileAsDataUrl(file);
  return {
    id: makeId("attachment"),
    type: "image",
    name: file.name || "图片",
    mimeType: file.type,
    size: file.size,
    dataUrl
  };
}

export async function createImageAttachmentFromPath(filePath: string): Promise<ImageMessageAttachment> {
  const nodeApi = getDesktopNodeFileApi();
  if (!nodeApi) {
    throw new Error("无法读取本地图片。");
  }
  const extension = nodeApi.path.extname(filePath).toLowerCase();
  const mimeType = SUPPORTED_IMAGE_EXTENSIONS.get(extension);
  if (!mimeType) {
    throw new Error("当前只支持 JPG、PNG、WebP 或 GIF 图片。");
  }

  const buffer = await nodeApi.fs.readFile(filePath);
  if (buffer.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error("图片不能超过 5MB。");
  }
  return {
    id: makeId("attachment"),
    type: "image",
    name: nodeApi.path.basename(filePath) || "图片",
    mimeType,
    size: buffer.byteLength,
    dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`
  };
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("无法读取图片内容。"));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => {
      reject(new Error("读取图片失败。"));
    };
    reader.readAsDataURL(file);
  });
}

export function getElectronOpenDialog(): ElectronOpenDialog | null {
  const runtimeRequire = getRuntimeRequire();
  if (!runtimeRequire) {
    return null;
  }
  try {
    const electron = runtimeRequire("electron") as {
      dialog?: ElectronOpenDialog;
      remote?: { dialog?: ElectronOpenDialog };
    };
    return electron.remote?.dialog ?? electron.dialog ?? null;
  } catch {
    return null;
  }
}

export function getDesktopNodeFileApi(): DesktopNodeFileApi | null {
  const runtimeRequire = getRuntimeRequire();
  if (!runtimeRequire) {
    return null;
  }
  try {
    const fsModule = runtimeRequire("fs") as { promises?: DesktopNodeFileApi["fs"] };
    const pathModule = runtimeRequire("path") as DesktopNodeFileApi["path"];
    if (!fsModule.promises) {
      return null;
    }
    return {
      fs: fsModule.promises,
      path: pathModule
    };
  } catch {
    return null;
  }
}

function getRuntimeRequire(): RuntimeRequire | null {
  if (typeof require === "function") {
    return require as RuntimeRequire;
  }
  const windowRequire = (window as Window & { require?: RuntimeRequire }).require;
  return typeof windowRequire === "function" ? windowRequire : null;
}
