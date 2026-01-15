import * as url from "url";
import * as https from "https";
import {
  ContentEncoding,
  RequestDetails,
  RequestOptions,
  SendResult,
  supportedContentEncodings,
  Urgency,
  WebPushError
} from "web-push";
import { Agent } from "node:https";

const urlBase64Helper: any = require('web-push/src/urlsafe-base64-helper');
const vapidHelper: any = require('web-push/src/vapid-helper');

// Default TTL is four weeks.
const DEFAULT_TTL = 2419200;
let gcmAPIKey = '';
let vapidDetails: {
    subject: string;
    publicKey: string;
    privateKey: string;
  }
  | undefined;

const supportedUrgency: {
  readonly VERY_LOW: "very-low" & Urgency;
  readonly LOW: "low" & Urgency;
  readonly NORMAL: "normal" & Urgency;
  readonly HIGH: "high" & Urgency;
} = {
  VERY_LOW: 'very-low',
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high'
};

type WebPushRequestDetails = RequestDetails & { agent?: Agent, timeout?: number, proxy?: any };

export type EncryptedPayload = {
  endpoint: string;
  contentEncoding: ContentEncoding;
  encrypted?: {
    localPublicKey: Buffer;
    salt: string;
    cipherText: Buffer;
  };
}

// basically original "sendNotification" function from web-push library with patched signature
export async function sendEncrypted(payload: EncryptedPayload, options?: RequestOptions): Promise<SendResult> {
  let requestDetails = await generateRequestDetails(payload, options);
  return new Promise(function (resolve, reject) {
    const httpsOptions: https.RequestOptions = {};
    const urlParts = url.parse(requestDetails.endpoint);
    httpsOptions.hostname = urlParts.hostname;
    httpsOptions.port = urlParts.port;
    httpsOptions.path = urlParts.path;

    httpsOptions.headers = requestDetails.headers;
    httpsOptions.method = requestDetails.method;

    if (requestDetails.timeout) {
      httpsOptions.timeout = requestDetails.timeout;
    }

    if (requestDetails.agent) {
      httpsOptions.agent = requestDetails.agent;
    }

    if (requestDetails.proxy) {
      const { HttpsProxyAgent } = require('https-proxy-agent'); // eslint-disable-line global-require
      httpsOptions.agent = new HttpsProxyAgent(requestDetails.proxy);
    }

    const pushRequest = https.request(httpsOptions, function (pushResponse) {
      let responseText = '';

      pushResponse.on('data', function (chunk) {
        responseText += chunk;
      });

      pushResponse.on('end', function () {
        if (pushResponse.statusCode! < 200 || pushResponse.statusCode! > 299) {
          reject(new WebPushError(
            'Received unexpected response code',
            pushResponse.statusCode!,
            pushResponse.headers as any,
            responseText,
            requestDetails.endpoint
          ));
        } else {
          resolve({
            statusCode: pushResponse.statusCode!,
            body: responseText,
            headers: pushResponse.headers as any
          });
        }
      });
    });

    if (requestDetails.timeout) {
      pushRequest.on('timeout', function () {
        pushRequest.destroy(new Error('Socket timeout'));
      });
    }

    pushRequest.on('error', function (e) {
      reject(e);
    });

    if (requestDetails.body) {
      pushRequest.write(requestDetails.body);
    }

    pushRequest.end();
  });
}

// original function from web-push library with patched signature
async function generateRequestDetails(payload: EncryptedPayload,
                                      options?: RequestOptions): Promise<WebPushRequestDetails> {
  let currentGCMAPIKey = gcmAPIKey;
  let currentVapidDetails = vapidDetails;
  let timeToLive = DEFAULT_TTL;
  let extraHeaders = {};
  let contentEncoding: ContentEncoding = payload.contentEncoding;
  let urgency: Urgency = supportedUrgency.NORMAL;
  let topic;
  let proxy;
  let agent;
  let timeout;

  if (options) {
    const validOptionKeys = [
      'headers',
      'gcmAPIKey',
      'vapidDetails',
      'TTL',
      'urgency',
      'topic',
      'proxy',
      'agent',
      'timeout'
    ];
    const optionKeys = Object.keys(options);
    for (let i = 0; i < optionKeys.length; i += 1) {
      const optionKey = optionKeys[i];
      if (!validOptionKeys.includes(optionKey)) {
        throw new Error('\'' + optionKey + '\' is an invalid option. '
          + 'The valid options are [\'' + validOptionKeys.join('\', \'')
          + '\'].');
      }
    }

    if (options.headers) {
      extraHeaders = options.headers;
      let duplicates = Object.keys(extraHeaders)
        .filter(function (header) {
          return typeof (options as any)[header] !== 'undefined';
        });

      if (duplicates.length > 0) {
        throw new Error('Duplicated headers defined ['
          + duplicates.join(',') + ']. Please either define the header in the'
          + 'top level options OR in the \'headers\' key.');
      }
    }

    if (options.gcmAPIKey) {
      currentGCMAPIKey = options.gcmAPIKey;
    }

    // Falsy values are allowed here so one can skip Vapid `else if` below and use FCM
    if (options.vapidDetails !== undefined) {
      currentVapidDetails = options.vapidDetails;
    }

    if (options.TTL !== undefined) {
      timeToLive = Number(options.TTL);
      if (timeToLive < 0) {
        throw new Error('TTL should be a number and should be at least 0');
      }
    }

    if (options.urgency) {
      if ((options.urgency === supportedUrgency.VERY_LOW
        || options.urgency === supportedUrgency.LOW
        || options.urgency === supportedUrgency.NORMAL
        || options.urgency === supportedUrgency.HIGH)) {
        urgency = options.urgency;
      } else {
        throw new Error('Unsupported urgency specified.');
      }
    }

    if (options.topic) {
      if (!urlBase64Helper.validate(options.topic)) {
        throw new Error('Unsupported characters set use the URL or filename-safe Base64 characters set');
      }
      if (options.topic.length > 32) {
        throw new Error('use maximum of 32 characters from the URL or filename-safe Base64 characters set');
      }
      topic = options.topic;
    }

    if (options.proxy) {
      if (typeof options.proxy === 'string'
        || typeof options.proxy.host === 'string') {
        proxy = options.proxy;
      } else {
        console.warn('Attempt to use proxy option, but invalid type it should be a string or proxy options object.');
      }
    }

    if (options.agent) {
      if (options.agent instanceof https.Agent) {
        if (proxy) {
          console.warn('Agent option will be ignored because proxy option is defined.');
        }

        agent = options.agent;
      } else {
        console.warn('Wrong type for the agent option, it should be an instance of https.Agent.');
      }
    }

    if (typeof options.timeout === 'number') {
      timeout = options.timeout;
    }
  }

  if (typeof timeToLive === 'undefined') {
    timeToLive = DEFAULT_TTL;
  }

  const requestDetails: WebPushRequestDetails = {
    method: 'POST',
    headers: {
      TTL: timeToLive as any
    }
  } as any;
  Object.keys(extraHeaders).forEach(function (header) {
    requestDetails.headers[header] = (extraHeaders as any)[header];
  });
  let requestPayload = null;

  if (payload.encrypted) {
    requestDetails.headers['Content-Length'] = payload.encrypted.cipherText.length as any;
    requestDetails.headers['Content-Type'] = 'application/octet-stream';

    if (contentEncoding === supportedContentEncodings.AES_128_GCM) {
      requestDetails.headers['Content-Encoding'] = supportedContentEncodings.AES_128_GCM;
    } else if (contentEncoding === supportedContentEncodings.AES_GCM) {
      requestDetails.headers['Content-Encoding'] = supportedContentEncodings.AES_GCM;
      requestDetails.headers['Encryption'] = 'salt=' + payload.encrypted.salt;
      requestDetails.headers['Crypto-Key'] = 'dh=' + payload.encrypted.localPublicKey.toString('base64url');
    }

    requestPayload = payload.encrypted.cipherText;
  } else {
    requestDetails.headers['Content-Length'] = 0 as any;
  }

  const isGCM = payload.endpoint.startsWith('https://android.googleapis.com/gcm/send');
  const isFCM = payload.endpoint.startsWith('https://fcm.googleapis.com/fcm/send');
  // VAPID isn't supported by GCM hence the if, else if.
  if (isGCM) {
    if (!currentGCMAPIKey) {
      console.warn('Attempt to send push notification to GCM endpoint, '
        + 'but no GCM key is defined. Please use setGCMApiKey() or add '
        + '\'gcmAPIKey\' as an option.');
    } else {
      requestDetails.headers['Authorization'] = 'key=' + currentGCMAPIKey;
    }
  } else if (currentVapidDetails) {
    const parsedUrl = url.parse(payload.endpoint);
    const audience = parsedUrl.protocol + '//'
      + parsedUrl.host;

    const vapidHeaders = vapidHelper.getVapidHeaders(
      audience,
      currentVapidDetails.subject,
      currentVapidDetails.publicKey,
      currentVapidDetails.privateKey,
      contentEncoding
    );

    requestDetails.headers['Authorization'] = vapidHeaders.Authorization;

    if (contentEncoding === supportedContentEncodings.AES_GCM) {
      if (requestDetails.headers['Crypto-Key']) {
        requestDetails.headers['Crypto-Key'] += ';'
          + vapidHeaders['Crypto-Key'];
      } else {
        requestDetails.headers['Crypto-Key'] = vapidHeaders['Crypto-Key'];
      }
    }
  } else if (isFCM && currentGCMAPIKey) {
    requestDetails.headers['Authorization'] = 'key=' + currentGCMAPIKey;
  }

  requestDetails.headers['Urgency'] = urgency;

  if (topic) {
    requestDetails.headers['Topic'] = topic;
  }

  requestDetails.body = requestPayload;
  requestDetails.endpoint = payload.endpoint;

  if (proxy) {
    requestDetails.proxy = proxy;
  }

  if (agent) {
    requestDetails['agent'] = agent;
  }

  if (timeout) {
    requestDetails['timeout'] = timeout;
  }

  return requestDetails;
}