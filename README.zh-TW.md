<p align="center"><img src="https://raw.githubusercontent.com/zyao-w/homebridge-http-advanced-accessory/master/branding/icon.png" width="100" height="100" alt="HTTP Advanced Accessory icon"></p>

<h1 align="center">homebridge http advanced accessory</h1>

<p align="center"><a href="README.md">English</a> | 繁體中文</p>

這是一個 Homebridge 外掛，可以把幾乎任何提供 HTTP API 的裝置變成 HomeKit 配件。每個裝置都在設定檔中描述：它是哪一種 HomeKit 服務、要呼叫哪些 URL 來「讀取」與「變更」每個特性（characteristic），以及如何把回應轉換成 HomeKit 需要的值。

本專案是 [homebridge-http-advanced-accessory](https://github.com/staromeste/homebridge-http-advanced-accessory) 的修改分支，獨立維護。新增了 Bearer Token 驗證、請求快取與去重、逾時與重試，以及（自 2.0.0 起）Dynamic Platform 與 Homebridge UI 表單。

> **從 1.x 升級？** 2.0.0 是不相容的變更：`HttpAdvancedAccessory` 配件已改為 `HttpAdvancedPlatform` 平台。請參閱 [MIGRATION.md](MIGRATION.md)，`scripts/migrate-config.js` 可以自動轉換你的設定。

> 本文件僅為簡要說明，完整且最新的內容請以英文版 [README.md](README.md) 為準。

## 安裝

1. 安裝 Homebridge（需要 Homebridge 2.4.0 以上與 Node.js 22 以上）：`npm install -g homebridge`
2. 安裝本外掛：`npm install -g homebridge-http-advanced-accessory-zyao`
3. 在 Homebridge UI（外掛頁面 > 設定）中設定，或把下方的平台區塊加入 `config.json` 最上層的 `platforms` 清單。本專案的 `sample-config.json` 是完整範例。

## 功能

- 可設定讀取與寫入每個特性的 HTTP 端點，支援 GET、POST（以及 PUT、PATCH、DELETE），參數可放在 URL 或請求本文
- 支援 Bearer Token 與 HTTP Basic 驗證；Token 可來自環境變數或檔案
- 自訂請求標頭（API 金鑰、`Content-Type` 等），可套用於全部裝置、單一裝置或單一動作
- 以 mapper 串接（正規表示式、XPath、JSONPath、靜態對照表、數字、縮放、expression、script）把回應轉成 HomeKit 的值；回應無法判斷時可使用備援動作
- URL 與請求本文的範本，可使用要設定的值與其他特性目前的狀態
- 定時輪詢，即使裝置被其他方式改變，HomeKit 也能收到通知
- 選用的 Status Fault，讀取失敗時 Home App 會顯示配件故障
- 讀取相同 URL 的特性共用一次請求、短時間回應快取、請求逾時、讀取重試，以及同時請求數上限
- 修改設定時，配件在 HomeKit 中的身分保持不變

## 設定

平台有一個選用的 `defaults`（所有裝置繼承的預設值）與一個 `devices`（裝置清單）：

```json
{
  "platforms": [
    {
      "platform": "HttpAdvancedPlatform",
      "name": "HTTP Advanced",
      "defaults": { "forceRefreshDelay": 5, "timeout": 5000, "bearerToken": "env:MY_API_TOKEN" },
      "devices": [
        {
          "name": "Terrace Sensor",
          "service": "ContactSensor",
          "characteristics": [
            {
              "characteristic": "ContactSensorState",
              "get": {
                "url": "http://remoteserver/xml/zones/zonesStatus48IP.xml",
                "mappers": [
                  { "type": "xpath", "xpath": "//status[1]/text()" },
                  {
                    "type": "static",
                    "mapping": [
                      { "from": "ALARM", "to": "1" },
                      { "from": "NORMAL", "to": "0" }
                    ]
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  ]
}
```

Homebridge 啟動時會驗證設定；有錯誤的裝置會在日誌中指出設定名稱並被略過，其他裝置仍正常運作。

### 常用裝置設定

| 設定                                    | 說明                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `name`                                  | 配件在 HomeKit 中的名稱。必填。                                                            |
| `id`                                    | 選用的固定識別碼。未設定時以 `name` 識別配件，改名會被視為新配件；設定 `id` 後可自由改名。 |
| `service`                               | HomeKit 服務，例如 `Switch`、`Lightbulb`、`TemperatureSensor`。必填。                      |
| `optionCharacteristic`                  | 要啟用的選用特性清單，例如 `["Brightness"]`。                                              |
| `manufacturer`、`model`、`serialNumber` | 顯示於 HomeKit 的配件資訊。                                                                |
| `characteristics`                       | 要讀取與寫入的特性清單。                                                                   |
| `additionalServices`                    | 同一配件上的其他服務。                                                                     |
| `forceRefreshDelay`                     | 輪詢間隔（秒），預設 0，表示不輪詢。                                                       |
| `setterDelay`                           | 送出設定請求前的等待毫秒數，期間若有新請求只會送出最後一個。預設 0。                       |
| `username`、`password`                  | HTTP Basic 帳號密碼。                                                                      |
| `bearerToken`                           | Bearer Token，可寫成 `env:變數名稱` 或 `file:/路徑/檔案`。                                 |
| `headers`                               | 額外的請求標頭。                                                                           |
| `statusFault`                           | 設為 `true` 時，讀取失敗會讓 Status Fault 顯示故障。預設 `false`。                         |
| `timeout`                               | 請求逾時毫秒數，預設 10000；0 表示不逾時。                                                 |
| `retries`                               | 讀取請求遇到網路錯誤或逾時時的額外重試次數，預設 0。                                       |
| `cacheTTL`                              | 成功的讀取回應重複使用的秒數。                                                             |
| `maxConcurrent`                         | 單一裝置同時進行的 HTTP 請求上限，預設 0（不限制）。                                       |
| `allowUnsafeEval`                       | 允許 `script` mapper 與範本中的 JavaScript，預設 `false`。                                 |
| `debug`                                 | 記錄每個請求與完整的對應過程。                                                             |

### 特性（characteristics）

`characteristics` 的每個項目對應服務中的一個 HomeKit 特性：

```json
{
  "characteristic": "TargetTemperature",
  "get": { "url": "http://remoteserver/temperature" },
  "set": { "url": "http://remoteserver/setTemperature?stemp={value}" },
  "props": { "minValue": 16, "maxValue": 30, "minStep": 0.5 }
}
```

- `characteristic`：HomeKit 特性名稱（比對時忽略空白）。
- `get`：讀取數值的動作；沒有時，特性不會輪詢，只回傳最後已知的值。
- `set`：寫入數值的動作；沒有時，HomeKit 設定的值會被接受，但不會送出任何請求。
- `props`：覆寫特性屬性，例如 `minValue`、`maxValue`、`minStep`、`validValues`。

### 動作（action）

`get` 與 `set` 使用相同的設定：`url`（必填）、`httpMethod`、`body`、`mappers`、`resultOnError`、`bearerToken`、`headers`、`inconclusive`。

在 `set` 動作的 URL 與 `body` 中，`{value}` 會被替換成經過 mapper 處理後的值，`${...}` 可寫運算式，並可使用 `value`（HomeKit 要設定的值）與 `state`（各特性目前的狀態，例如 `state.TargetTemperature`）。

### Mapper

Mapper 串接會把回應逐步轉換成 HomeKit 需要的單一數值，前一個 mapper 的輸出是下一個的輸入。可用類型：`static`、`regex`、`xpath`、`jpath`、`number`、`scale`、`expression`、`script`。

## 驗證

1. **Bearer Token**：設定 `bearerToken`，外掛會送出 `Authorization: Bearer <token>`。
2. **HTTP Basic**：設定 `username` 與 `password`（未設定 `bearerToken` 時使用）。

兩者都設定時以 Bearer Token 為準。不支援 HTTP Digest 驗證。

## 疑難排解

- 在裝置中設定 `"debug": true`，即可在日誌中看到每個請求與對應過程。
- 讀取失敗時，Home App 會顯示「無回應」，原因會寫入 Homebridge 日誌。
- 更多支援的服務、設定範例（Bticino、Daikin、Yamaha Musiccast 等）與完整選項，請見 [README.md](README.md)。

## 授權

請見 [LICENSE](LICENSE)。
