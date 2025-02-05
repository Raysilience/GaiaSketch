/*
 * Copyright (c) 2022, Alibaba Group Holding Limited;
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as sketch from "sketch/dom";
import * as fs from "@skpm/fs";
import * as path from "@skpm/path";
import * as os from "@skpm/os";
import dialog from "@skpm/dialog";
import {getURLFromPath} from "./helper";
import {doExportCode} from "./code/portal";
import * as Settings from "sketch/settings";
import {getWebview} from "sketch-module-web-view/remote";
import {assetsDir} from "./code/code-helper";

export function onLayerToCodeDestroy() {
  let previewPath = path.join(os.tmpdir(), "gaia-export-code-preview");
  if (fs.existsSync(previewPath)) {
    try {
      fs.rmdirSync(previewPath);
    } catch (error) {}
  }
}

export function onLayerToCodeSelectionChanged(context) {
  let barType = Settings.settingForKey("barType");
  if (barType == "ExportCode") {
    const existingWebview = getWebview("gaia.sketch.webview");
    if (existingWebview) {
      getSelectedLayerPreview(existingWebview.webContents);
    }
  }
}

function getSelectedLayerPreview(webContents) {
  let document = sketch.Document.getSelectedDocument();
  let selectedLayer;
  if (
    document == undefined ||
    !document.selectedLayers ||
    document.selectedLayers.layers.length <= 0
  ) {
    webContents.executeJavaScript(`onDidGetSelectedLayerPreview()`);
  } else {
    selectedLayer = document.selectedLayers.layers[0];
    let screenshotPath = path.join(os.tmpdir(), "gaia-export-code-preview");
    if (!fs.existsSync(screenshotPath)) {
      fs.mkdirSync(screenshotPath);
    }
    sketch.export(selectedLayer, {
      "use-id-for-name": true,
      formats: "png",
      scales: "2",
      trimmed: false,
      output: screenshotPath,
      "group-contents-only": true,
      overwriting: true,
    });
    let base64String = fs.readFileSync(
      path.join(screenshotPath, selectedLayer.id + "@2x.png"),
      {
        encoding: "base64",
      }
    );
    webContents.executeJavaScript(
      `onDidGetSelectedLayerPreview(${JSON.stringify({
        id: selectedLayer.id,
        name: selectedLayer.name,
        previewPath: "data:image/png;base64, " + base64String,
      })})`
    );
  }
}

export function registerExportCodeIPC(context, webContents) {
  webContents.on("getSelectedLayerPreview", () => {
    getSelectedLayerPreview(webContents);
  });
  webContents.on("exportCode", (selectedLayers, language) => {
    let document = sketch.Document.getSelectedDocument();
    if (document) {
      layerToCode(context, document, selectedLayers, language)
        .then((data) => {
          webContents.executeJavaScript(
            `onDidExportCode(${JSON.stringify({
              codeFolder: data.codeFolder,
            })})`
          );
        })
        .catch((error) => {
          webContents.executeJavaScript(
            `onDidExportCode(${JSON.stringify({
              errorMessage: error.message,
            })})`
          );
        });
    }
  });
}

function layerToCode(context, document, selectedLayers, languages) {
  return new Promise((resolve, reject) => {
    dialog
      .showSaveDialog({ message: "请选择要保存到的目录" })
      .then(({ canceled, filePath }) => {
        if (!canceled && filePath && filePath.length > 0) {
          if (fs.existsSync(filePath)) {
            try {
              fs.rmdirSync(filePath);
            } catch (error) {}
          }
          fs.mkdirSync(filePath);
          let assetsPath = assetsDir();
          let toPath = path.join(
            os.tmpdir(),
            `gaia_code_temporary_${String(NSUUID.UUID().UUIDString())}.sketch`
          );
          let fromPath;
          let saveMode = sketch.Document.SaveMode.Save;
          if (document.path) {
            fromPath = decodeURIComponent(document.path);
          } else {
            fromPath = path.join(
              os.tmpdir(),
              `${String(NSUUID.UUID().UUIDString())}.sketch`
            );
            saveMode = sketch.Document.SaveMode.SaveTo;
          }
          document.save(
            getURLFromPath(fromPath),
            { saveMode },
            async (error) => {
              fs.copyFileSync(fromPath, toPath);
              let doc =
                NSDocumentController.sharedDocumentController().openDocumentWithContentsOfURL_display_error(
                  getURLFromPath(toPath),
                  false,
                  null
                );
              doc = sketch.Document.fromNative(doc);
              for (let i = 0; i < selectedLayers.length; i++) {
                if (fs.existsSync(assetsPath)) {
                  try {
                    fs.rmdirSync(assetsPath);
                  } catch (error) {}
                }
                fs.mkdirSync(assetsPath);
                let selectedLayer = doc.getLayerWithID(selectedLayers[i].key);
                let selectedLayerPath = path.join(
                  filePath,
                  selectedLayers[i].name.replaceAll("/", "_")
                );
                if (fs.existsSync(selectedLayerPath)) {
                  try {
                    fs.rmdirSync(selectedLayerPath);
                  } catch (error) {}
                }
                fs.mkdirSync(selectedLayerPath);
                if (
                  selectedLayer.type !== "SymbolInstance" &&
                  (selectedLayer.layers === undefined ||
                    selectedLayer.layers <= 0)
                ) {
                  let newGroup = new sketch.Group({
                    name: "Group",
                    layers: [],
                  });
                  newGroup.parent = selectedLayer.parent;
                  newGroup.index = selectedLayer.index;
                  selectedLayer.parent = newGroup;
                  newGroup.adjustToFit();
                  selectedLayer = newGroup;
                }
                await doExportCode(
                  context,
                  document,
                  toPath,
                  selectedLayer,
                  languages,
                  selectedLayerPath
                );
                fs.copyFileSync(
                  assetsPath,
                  path.join(selectedLayerPath, "assets")
                );
              }
              doc &&
                doc.save(toPath, (err) => {
                  doc.close();
                  // TODO:暂时删除
                  if (fs.existsSync(toPath)) {
                    fs.unlinkSync(toPath);
                  }
                  resolve({ codeFolder: filePath });
                });
            }
          );
        } else {
          reject(new Error("已取消"));
        }
      });
  });
}
