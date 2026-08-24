var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// node_modules/gotrue-js/lib/index.js
var HTTPError = class extends Error {
  constructor(response) {
    super(response.statusText);
    this.name = "HTTPError";
    this.status = response.status;
  }
};
var TextHTTPError = class extends HTTPError {
  constructor(response, data) {
    super(response);
    this.name = "TextHTTPError";
    this.data = data;
  }
};
var JSONHTTPError = class extends HTTPError {
  constructor(response, json) {
    super(response);
    this.name = "JSONHTTPError";
    this.json = json;
  }
};
var API = class _API {
  constructor(apiURL, options) {
    this.apiURL = apiURL || "";
    this._sameOrigin = /^\/(?!\/)/.test(this.apiURL);
    this.defaultHeaders = options?.defaultHeaders || {};
  }
  headers(headers = {}) {
    return {
      ...this.defaultHeaders,
      "Content-Type": "application/json",
      ...headers
    };
  }
  static async parseJsonResponse(response) {
    const json = await response.json();
    if (!response.ok) {
      throw new JSONHTTPError(response, json);
    }
    return json;
  }
  async request(path, options = {}) {
    const headers = this.headers(options.headers || {});
    if (!options.body) {
      delete headers["Content-Type"];
    }
    const fetchOptions = {
      ...options,
      headers
    };
    if (this._sameOrigin) {
      fetchOptions.credentials = options.credentials || "same-origin";
    }
    const response = await fetch(this.apiURL + path, fetchOptions);
    const contentType = response.headers.get("Content-Type");
    if (contentType?.includes("json")) {
      return _API.parseJsonResponse(response);
    }
    const data = await response.text();
    if (!response.ok) {
      throw new TextHTTPError(response, data);
    }
    return data;
  }
};
var Admin = class {
  constructor(user) {
    this.user = user;
  }
  listUsers(aud) {
    return this.user._request("/admin/users", {
      method: "GET",
      audience: aud
    });
  }
  getUser(user) {
    return this.user._request(`/admin/users/${user.id}`);
  }
  updateUser(user, attributes = {}) {
    return this.user._request(`/admin/users/${user.id}`, {
      method: "PUT",
      body: JSON.stringify(attributes)
    });
  }
  createUser(email, password, attributes = {}) {
    attributes.email = email;
    attributes.password = password;
    return this.user._request("/admin/users", {
      method: "POST",
      body: JSON.stringify(attributes)
    });
  }
  deleteUser(user) {
    return this.user._request(`/admin/users/${user.id}`, {
      method: "DELETE"
    });
  }
};
var ExpiryMargin = 60 * 1e3;
var storageKey = "gotrue.user";
var refreshPromises = {};
var currentUser = null;
var forbiddenUpdateAttributes = { api: 1, token: 1, audience: 1, url: 1 };
var forbiddenSaveAttributes = { api: 1 };
var isBrowser = () => typeof window !== "undefined";
var storageListenerActive = false;
function ensureStorageListener() {
  if (!storageListenerActive && isBrowser()) {
    storageListenerActive = true;
    window.addEventListener("storage", (event) => {
      if (event.key === storageKey) {
        currentUser = null;
      }
    });
  }
}
var User = class _User {
  constructor(api2, tokenResponse, audience) {
    this.token = null;
    this.api = api2;
    this.url = api2.apiURL;
    this.audience = audience;
    this._processTokenResponse(tokenResponse);
    currentUser = this;
    ensureStorageListener();
  }
  static removeSavedSession() {
    isBrowser() && localStorage.removeItem(storageKey);
  }
  static recoverSession(apiInstance) {
    ensureStorageListener();
    if (currentUser) {
      return currentUser;
    }
    const json = isBrowser() && localStorage.getItem(storageKey);
    if (json) {
      try {
        const data = JSON.parse(json);
        const { url, token, audience } = data;
        if (!url || !token) {
          return null;
        }
        const api2 = apiInstance || new API(url, {});
        return new _User(api2, token, audience)._saveUserData(data, true);
      } catch (error) {
        console.error(new Error(`Gotrue-js: Error recovering session: ${error}`));
        return null;
      }
    }
    return null;
  }
  get admin() {
    return new Admin(this);
  }
  async update(attributes) {
    const response = await this._request("/user", {
      method: "PUT",
      body: JSON.stringify(attributes)
    });
    return this._saveUserData(response)._refreshSavedSession();
  }
  jwt(forceRefresh) {
    const token = this.tokenDetails();
    if (token === null || token === void 0) {
      return Promise.reject(new Error(`Gotrue-js: failed getting jwt access token`));
    }
    const { expires_at, refresh_token, access_token } = token;
    if (forceRefresh || expires_at - ExpiryMargin < Date.now()) {
      return this._refreshToken(refresh_token);
    }
    return Promise.resolve(access_token);
  }
  logout() {
    return this._request("/logout", { method: "POST" }).then(this.clearSession.bind(this)).catch(this.clearSession.bind(this));
  }
  _refreshToken(refresh_token) {
    const existingPromise = refreshPromises[refresh_token];
    if (existingPromise) {
      return existingPromise;
    }
    const refreshRequest = this.api.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${refresh_token}`
    });
    const timeoutPromise = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("Token refresh timeout")), 3e4);
    });
    const promise = Promise.race([refreshRequest, timeoutPromise]).then((response) => {
      delete refreshPromises[refresh_token];
      this._processTokenResponse(response);
      this._refreshSavedSession();
      if (!this.token) {
        throw new Error("Gotrue-js: Token not set after refresh");
      }
      return this.token.access_token;
    }).catch((error) => {
      delete refreshPromises[refresh_token];
      this.clearSession();
      throw error;
    });
    refreshPromises[refresh_token] = promise;
    return promise;
  }
  async _request(path, options = {}) {
    options.headers = options.headers || {};
    const aud = options.audience || this.audience;
    if (aud) {
      options.headers["X-JWT-AUD"] = aud;
    }
    try {
      const token = await this.jwt();
      return await this.api.request(path, {
        headers: Object.assign(options.headers, {
          Authorization: `Bearer ${token}`
        }),
        ...options
      });
    } catch (error) {
      if (error instanceof JSONHTTPError && error.json) {
        if (error.json.msg) {
          error.message = error.json.msg;
        } else if (error.json.error) {
          error.message = `${error.json.error}: ${error.json.error_description}`;
        }
      }
      throw error;
    }
  }
  async getUserData() {
    const response = await this._request("/user");
    return this._saveUserData(response)._refreshSavedSession();
  }
  _saveUserData(attributes, fromStorage) {
    for (const key in attributes) {
      if (key in _User.prototype || key in forbiddenUpdateAttributes) {
        continue;
      }
      this[key] = attributes[key];
    }
    if (fromStorage) {
      this._fromStorage = true;
    }
    return this;
  }
  _processTokenResponse(tokenResponse) {
    this.token = tokenResponse;
    try {
      const claims = JSON.parse(urlBase64Decode(tokenResponse.access_token.split(".")[1]));
      this.token.expires_at = claims.exp * 1e3;
    } catch (error) {
      console.error(new Error(`Gotrue-js: Failed to parse tokenResponse claims: ${error}`));
    }
  }
  _refreshSavedSession() {
    if (isBrowser() && localStorage.getItem(storageKey)) {
      this._saveSession();
    }
    return this;
  }
  get _details() {
    const userCopy = {};
    for (const key in this) {
      if (key in _User.prototype || key in forbiddenSaveAttributes) {
        continue;
      }
      userCopy[key] = this[key];
    }
    return userCopy;
  }
  _saveSession() {
    isBrowser() && localStorage.setItem(storageKey, JSON.stringify(this._details));
    return this;
  }
  tokenDetails() {
    return this.token;
  }
  clearSession() {
    _User.removeSavedSession();
    this.token = null;
    currentUser = null;
  }
};
function base64Decode(base64) {
  if (typeof atob === "function") {
    return atob(base64);
  }
  return Buffer.from(base64, "base64").toString("binary");
}
function urlBase64Decode(str) {
  let output = str.replace(/-/g, "+").replace(/_/g, "/");
  switch (output.length % 4) {
    case 0:
      break;
    case 2:
      output += "==";
      break;
    case 3:
      output += "=";
      break;
    default:
      throw new Error("Illegal base64url string!");
  }
  const binaryString = base64Decode(output);
  try {
    const bytes = Uint8Array.from(binaryString, (char) => char.codePointAt(0) ?? 0);
    return new TextDecoder().decode(bytes);
  } catch {
    return binaryString;
  }
}
var HTTPRegexp = /^http:\/\//;
var defaultApiURL = `/.netlify/identity`;
var GoTrue = class {
  constructor({
    APIUrl = defaultApiURL,
    audience = "",
    setCookie = false,
    clientName = "gotrue-js"
  } = {}) {
    if (HTTPRegexp.test(APIUrl)) {
      console.warn(
        "Warning:\n\nDO NOT USE HTTP IN PRODUCTION FOR GOTRUE EVER!\nGoTrue REQUIRES HTTPS to work securely."
      );
    }
    if (audience) {
      this.audience = audience;
    }
    this.setCookie = setCookie;
    this.api = new API(APIUrl, { defaultHeaders: { "X-Nf-Client": clientName } });
  }
  async _request(path, options = {}) {
    options.headers = options.headers || {};
    const aud = options.audience || this.audience;
    if (aud) {
      options.headers["X-JWT-AUD"] = aud;
    }
    try {
      return await this.api.request(path, options);
    } catch (error) {
      if (error instanceof JSONHTTPError && error.json) {
        if (error.json.msg) {
          error.message = error.json.msg;
        } else if (error.json.error) {
          error.message = `${error.json.error}: ${error.json.error_description}`;
        }
      }
      throw error;
    }
  }
  settings() {
    return this._request("/settings");
  }
  signup(email, password, data) {
    return this._request("/signup", {
      method: "POST",
      body: JSON.stringify({ email, password, data })
    });
  }
  login(email, password, remember) {
    this._setRememberHeaders(remember);
    return this._request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=password&username=${encodeURIComponent(
        email
      )}&password=${encodeURIComponent(password)}`
    }).then((response) => {
      User.removeSavedSession();
      return this.createUser(response, remember);
    });
  }
  loginExternalUrl(provider) {
    return `${this.api.apiURL}/authorize?provider=${provider}`;
  }
  confirm(token, remember) {
    this._setRememberHeaders(remember);
    return this.verify("signup", token, remember);
  }
  requestPasswordRecovery(email) {
    return this._request("/recover", {
      method: "POST",
      body: JSON.stringify({ email })
    });
  }
  recover(token, remember) {
    this._setRememberHeaders(remember);
    return this.verify("recovery", token, remember);
  }
  acceptInvite(token, password, remember) {
    this._setRememberHeaders(remember);
    return this._request("/verify", {
      method: "POST",
      body: JSON.stringify({ token, password, type: "signup" })
    }).then((response) => this.createUser(response, remember));
  }
  acceptInviteExternalUrl(provider, token) {
    return `${this.api.apiURL}/authorize?provider=${provider}&invite_token=${token}`;
  }
  createUser(tokenResponse, remember = false) {
    this._setRememberHeaders(remember);
    const user = new User(this.api, tokenResponse, this.audience || "");
    return user.getUserData().then((userData) => {
      if (remember) {
        userData._saveSession();
      }
      return userData;
    });
  }
  currentUser() {
    const user = User.recoverSession(this.api);
    user && this._setRememberHeaders(user._fromStorage);
    return user;
  }
  async validateCurrentSession() {
    const user = this.currentUser();
    if (!user) {
      return null;
    }
    try {
      return await user.getUserData();
    } catch {
      user.clearSession();
      return null;
    }
  }
  verify(type, token, remember) {
    this._setRememberHeaders(remember);
    return this._request("/verify", {
      method: "POST",
      body: JSON.stringify({ token, type })
    }).then((response) => this.createUser(response, remember));
  }
  _setRememberHeaders(remember) {
    if (this.setCookie) {
      this.api.defaultHeaders = this.api.defaultHeaders || {};
      this.api.defaultHeaders["X-Use-Cookie"] = remember ? "1" : "session";
    }
  }
};
if (typeof window !== "undefined") {
  window.GoTrue = GoTrue;
}

// node_modules/@netlify/identity/dist/main.js
var __require2 = /* @__PURE__ */ ((x) => typeof __require !== "undefined" ? __require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof __require !== "undefined" ? __require : a)[b]
}) : x)(function(x) {
  if (typeof __require !== "undefined") return __require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var AUTH_PROVIDERS = ["google", "github", "gitlab", "bitbucket", "facebook", "email"];
var AuthError = class _AuthError extends Error {
  constructor(message, status, options) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    if (options && "cause" in options) {
      this.cause = options.cause;
    }
  }
  static from(error) {
    if (error instanceof _AuthError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new _AuthError(message, void 0, { cause: error });
  }
};
var MissingIdentityError = class extends Error {
  constructor(message = "Netlify Identity is not available.") {
    super(message);
    this.name = "MissingIdentityError";
  }
};
var IDENTITY_PATH = "/.netlify/identity";
var goTrueClient = null;
var cachedApiUrl;
var warnedMissingUrl = false;
var isBrowser2 = () => typeof window !== "undefined" && typeof window.location !== "undefined";
var discoverApiUrl = () => {
  if (cachedApiUrl !== void 0) return cachedApiUrl;
  if (isBrowser2()) {
    cachedApiUrl = `${window.location.origin}${IDENTITY_PATH}`;
  } else {
    const identityContext = getIdentityContext();
    if (identityContext?.url) {
      cachedApiUrl = identityContext.url;
    } else if (globalThis.Netlify?.context?.url) {
      cachedApiUrl = new URL(IDENTITY_PATH, globalThis.Netlify.context.url).href;
    } else if (typeof process !== "undefined" && process.env?.URL) {
      cachedApiUrl = new URL(IDENTITY_PATH, process.env.URL).href;
    }
  }
  return cachedApiUrl ?? null;
};
var getGoTrueClient = () => {
  if (goTrueClient) return goTrueClient;
  const apiUrl = discoverApiUrl();
  if (!apiUrl) {
    if (!warnedMissingUrl) {
      console.warn(
        "@netlify/identity: Could not determine the Identity endpoint URL. Make sure your site has Netlify Identity enabled, or run your app with `netlify dev`."
      );
      warnedMissingUrl = true;
    }
    return null;
  }
  goTrueClient = new GoTrue({ APIUrl: apiUrl, setCookie: false });
  return goTrueClient;
};
var getClient = () => {
  const client = getGoTrueClient();
  if (!client) throw new MissingIdentityError();
  return client;
};
var getIdentityContext = () => {
  const identityContext = globalThis.netlifyIdentityContext;
  if (identityContext?.url) {
    return {
      url: identityContext.url,
      token: identityContext.token
    };
  }
  if (globalThis.Netlify?.context?.url) {
    return { url: new URL(IDENTITY_PATH, globalThis.Netlify.context.url).href };
  }
  const siteUrl = typeof process !== "undefined" ? process.env?.URL : void 0;
  if (siteUrl) {
    return { url: new URL(IDENTITY_PATH, siteUrl).href };
  }
  return null;
};
var NF_JWT_COOKIE = "nf_jwt";
var NF_REFRESH_COOKIE = "nf_refresh";
var getCookie = (name) => {
  if (typeof document === "undefined") return null;
  const match = new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`).exec(document.cookie);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};
var setAuthCookies = (cookies, accessToken, refreshToken) => {
  cookies.set({
    name: NF_JWT_COOKIE,
    value: accessToken,
    httpOnly: false,
    secure: true,
    path: "/",
    sameSite: "Lax"
  });
  if (refreshToken) {
    cookies.set({
      name: NF_REFRESH_COOKIE,
      value: refreshToken,
      httpOnly: false,
      secure: true,
      path: "/",
      sameSite: "Lax"
    });
  }
};
var deleteAuthCookies = (cookies) => {
  cookies.delete(NF_JWT_COOKIE);
  cookies.delete(NF_REFRESH_COOKIE);
};
var setBrowserAuthCookies = (accessToken, refreshToken) => {
  if (typeof document === "undefined") return;
  document.cookie = `${NF_JWT_COOKIE}=${encodeURIComponent(accessToken)}; path=/; secure; samesite=lax`;
  if (refreshToken) {
    document.cookie = `${NF_REFRESH_COOKIE}=${encodeURIComponent(refreshToken)}; path=/; secure; samesite=lax`;
  }
};
var deleteBrowserAuthCookies = () => {
  if (typeof document === "undefined") return;
  document.cookie = `${NF_JWT_COOKIE}=; path=/; secure; samesite=lax; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  document.cookie = `${NF_REFRESH_COOKIE}=; path=/; secure; samesite=lax; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
};
var getServerCookie = (name) => {
  const cookies = globalThis.Netlify?.context?.cookies;
  if (!cookies || typeof cookies.get !== "function") return null;
  return cookies.get(name) ?? null;
};
var nextHeadersFn;
var triggerNextjsDynamic = () => {
  if (nextHeadersFn === null) return;
  if (nextHeadersFn === void 0) {
    try {
      if (typeof __require2 === "undefined") {
        nextHeadersFn = null;
        return;
      }
      const mod = __require2("next/headers");
      nextHeadersFn = mod.headers;
    } catch {
      nextHeadersFn = null;
      return;
    }
  }
  const fn = nextHeadersFn;
  if (!fn) return;
  try {
    fn();
  } catch (e) {
    if (e instanceof Error && ("digest" in e || /bail\s*out.*prerende/i.test(e.message))) {
      throw e;
    }
  }
};
var DEFAULT_TIMEOUT_MS = 5e3;
var fetchWithTimeout = async (url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      const pathname = new URL(url).pathname;
      throw new AuthError(`Identity request to ${pathname} timed out after ${String(timeoutMs)}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
var AUTH_EVENTS = {
  LOGIN: "login",
  LOGOUT: "logout",
  TOKEN_REFRESH: "token_refresh",
  USER_UPDATED: "user_updated",
  RECOVERY: "recovery"
};
var listeners = /* @__PURE__ */ new Set();
var emitAuthEvent = (event, user) => {
  for (const listener of listeners) {
    try {
      listener(event, user);
    } catch {
    }
  }
};
var REFRESH_MARGIN_S = 60;
var refreshTimer = null;
var startTokenRefresh = () => {
  if (!isBrowser2()) return;
  stopTokenRefresh();
  const client = getGoTrueClient();
  const user = client?.currentUser();
  if (!user) return;
  const token = user.tokenDetails();
  if (!token?.expires_at) return;
  const nowS = Math.floor(Date.now() / 1e3);
  const expiresAtS = typeof token.expires_at === "number" && token.expires_at > 1e12 ? Math.floor(token.expires_at / 1e3) : token.expires_at;
  const delayMs = Math.max(0, expiresAtS - nowS - REFRESH_MARGIN_S) * 1e3;
  refreshTimer = setTimeout(() => {
    void (async () => {
      try {
        const freshJwt = await user.jwt(true);
        const freshDetails = user.tokenDetails();
        setBrowserAuthCookies(freshJwt, freshDetails?.refresh_token);
        emitAuthEvent(AUTH_EVENTS.TOKEN_REFRESH, toUser(user));
        startTokenRefresh();
      } catch {
        stopTokenRefresh();
      }
    })();
  }, delayMs);
};
var stopTokenRefresh = () => {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
};
var getCookies = () => {
  const cookies = globalThis.Netlify?.context?.cookies;
  if (!cookies) {
    throw new AuthError("Server-side auth requires Netlify Functions runtime");
  }
  return cookies;
};
var getServerIdentityUrl = () => {
  const ctx = getIdentityContext();
  if (!ctx?.url) {
    throw new AuthError("Could not determine the Identity endpoint URL on the server");
  }
  return ctx.url;
};
var persistSession = true;
var login = async (email, password) => {
  if (!isBrowser2()) {
    const identityUrl = getServerIdentityUrl();
    const cookies = getCookies();
    const body = new URLSearchParams({
      grant_type: "password",
      username: email,
      password
    });
    let res;
    try {
      res = await fetchWithTimeout(`${identityUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      });
    } catch (error) {
      throw AuthError.from(error);
    }
    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({}));
      throw new AuthError(
        errorBody.msg ?? errorBody.error_description ?? `Login failed (${String(res.status)})`,
        res.status
      );
    }
    const data = await res.json();
    const accessToken = data.access_token;
    let userRes;
    try {
      userRes = await fetchWithTimeout(`${identityUrl}/user`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
    } catch (error) {
      throw AuthError.from(error);
    }
    if (!userRes.ok) {
      const errorBody = await userRes.json().catch(() => ({}));
      throw new AuthError(errorBody.msg ?? `Failed to fetch user data (${String(userRes.status)})`, userRes.status);
    }
    const userData = await userRes.json();
    const user = toUser(userData);
    setAuthCookies(cookies, accessToken, data.refresh_token);
    return user;
  }
  const client = getClient();
  try {
    const gotrueUser = await client.login(email, password, persistSession);
    const jwt = await gotrueUser.jwt();
    setBrowserAuthCookies(jwt, gotrueUser.tokenDetails()?.refresh_token);
    const user = toUser(gotrueUser);
    startTokenRefresh();
    emitAuthEvent(AUTH_EVENTS.LOGIN, user);
    return user;
  } catch (error) {
    throw AuthError.from(error);
  }
};
var signup = async (email, password, data) => {
  if (!isBrowser2()) {
    const identityUrl = getServerIdentityUrl();
    const cookies = getCookies();
    let res;
    try {
      res = await fetchWithTimeout(`${identityUrl}/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, data })
      });
    } catch (error) {
      throw AuthError.from(error);
    }
    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({}));
      throw new AuthError(errorBody.msg ?? `Signup failed (${String(res.status)})`, res.status);
    }
    const responseData = await res.json();
    const user = toUser(responseData);
    if (responseData.confirmed_at) {
      const accessToken = responseData.access_token;
      if (accessToken) {
        setAuthCookies(cookies, accessToken, responseData.refresh_token);
      }
    }
    return user;
  }
  const client = getClient();
  try {
    const response = await client.signup(email, password, data);
    const user = toUser(response);
    if (response.confirmed_at) {
      const jwt = await response.jwt?.();
      if (jwt) {
        const refreshToken = response.tokenDetails?.()?.refresh_token;
        setBrowserAuthCookies(jwt, refreshToken);
      }
      startTokenRefresh();
      emitAuthEvent(AUTH_EVENTS.LOGIN, user);
    }
    return user;
  } catch (error) {
    throw AuthError.from(error);
  }
};
var logout = async () => {
  if (!isBrowser2()) {
    const identityUrl = getServerIdentityUrl();
    const cookies = getCookies();
    const jwt = cookies.get(NF_JWT_COOKIE);
    if (jwt) {
      try {
        await fetchWithTimeout(`${identityUrl}/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${jwt}` }
        });
      } catch {
      }
    }
    deleteAuthCookies(cookies);
    return;
  }
  const client = getClient();
  try {
    const currentUser2 = client.currentUser();
    if (currentUser2) {
      await currentUser2.logout();
    }
    deleteBrowserAuthCookies();
    stopTokenRefresh();
    emitAuthEvent(AUTH_EVENTS.LOGOUT, null);
  } catch (error) {
    throw AuthError.from(error);
  }
};
var handleAuthCallback = async () => {
  if (!isBrowser2()) return null;
  const hash = window.location.hash.substring(1);
  if (!hash) return null;
  const client = getClient();
  const params = new URLSearchParams(hash);
  try {
    const accessToken = params.get("access_token");
    if (accessToken) return await handleOAuthCallback(client, params, accessToken);
    const confirmationToken = params.get("confirmation_token");
    if (confirmationToken) return await handleConfirmationCallback(client, confirmationToken);
    const recoveryToken = params.get("recovery_token");
    if (recoveryToken) return await handleRecoveryCallback(client, recoveryToken);
    const inviteToken = params.get("invite_token");
    if (inviteToken) return handleInviteCallback(inviteToken);
    const emailChangeToken = params.get("email_change_token");
    if (emailChangeToken) return await handleEmailChangeCallback(client, emailChangeToken);
    return null;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw AuthError.from(error);
  }
};
var handleOAuthCallback = async (client, params, accessToken) => {
  const refreshToken = params.get("refresh_token") ?? "";
  const expiresIn = parseInt(params.get("expires_in") ?? "", 10);
  const expiresAt = parseInt(params.get("expires_at") ?? "", 10);
  const gotrueUser = await client.createUser(
    {
      access_token: accessToken,
      token_type: params.get("token_type") ?? "bearer",
      expires_in: isFinite(expiresIn) ? expiresIn : 3600,
      expires_at: isFinite(expiresAt) ? expiresAt : Math.floor(Date.now() / 1e3) + 3600,
      refresh_token: refreshToken
    },
    persistSession
  );
  setBrowserAuthCookies(accessToken, refreshToken || void 0);
  const user = toUser(gotrueUser);
  startTokenRefresh();
  clearHash();
  emitAuthEvent(AUTH_EVENTS.LOGIN, user);
  return { type: "oauth", user };
};
var handleConfirmationCallback = async (client, token) => {
  const gotrueUser = await client.confirm(token, persistSession);
  const jwt = await gotrueUser.jwt();
  setBrowserAuthCookies(jwt, gotrueUser.tokenDetails()?.refresh_token);
  const user = toUser(gotrueUser);
  startTokenRefresh();
  clearHash();
  emitAuthEvent(AUTH_EVENTS.LOGIN, user);
  return { type: "confirmation", user };
};
var handleRecoveryCallback = async (client, token) => {
  const gotrueUser = await client.recover(token, persistSession);
  const jwt = await gotrueUser.jwt();
  setBrowserAuthCookies(jwt, gotrueUser.tokenDetails()?.refresh_token);
  const user = toUser(gotrueUser);
  startTokenRefresh();
  clearHash();
  emitAuthEvent(AUTH_EVENTS.RECOVERY, user);
  return { type: "recovery", user };
};
var handleInviteCallback = (token) => {
  clearHash();
  return { type: "invite", user: null, token };
};
var handleEmailChangeCallback = async (client, emailChangeToken) => {
  const currentUser2 = client.currentUser();
  if (!currentUser2) {
    throw new AuthError("Email change verification requires an active browser session");
  }
  const jwt = await currentUser2.jwt();
  const identityUrl = `${window.location.origin}${IDENTITY_PATH}`;
  const emailChangeRes = await fetch(`${identityUrl}/user`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({ email_change_token: emailChangeToken })
  });
  if (!emailChangeRes.ok) {
    const errorBody = await emailChangeRes.json().catch(() => ({}));
    throw new AuthError(
      errorBody.msg ?? `Email change verification failed (${String(emailChangeRes.status)})`,
      emailChangeRes.status
    );
  }
  const emailChangeData = await emailChangeRes.json();
  const user = toUser(emailChangeData);
  clearHash();
  emitAuthEvent(AUTH_EVENTS.USER_UPDATED, user);
  return { type: "email_change", user };
};
var clearHash = () => {
  history.replaceState(null, "", window.location.pathname + window.location.search);
};
var hydrateSession = async () => {
  if (!isBrowser2()) return null;
  const client = getClient();
  const currentUser2 = client.currentUser();
  if (currentUser2) {
    startTokenRefresh();
    return toUser(currentUser2);
  }
  const accessToken = getCookie(NF_JWT_COOKIE);
  if (!accessToken) return null;
  const refreshToken = getCookie(NF_REFRESH_COOKIE) ?? "";
  const decoded = decodeJwtPayload(accessToken);
  const expiresAt = decoded?.exp ?? Math.floor(Date.now() / 1e3) + 3600;
  const expiresIn = Math.max(0, expiresAt - Math.floor(Date.now() / 1e3));
  let gotrueUser;
  try {
    gotrueUser = await client.createUser(
      {
        access_token: accessToken,
        token_type: "bearer",
        expires_in: expiresIn,
        expires_at: expiresAt,
        refresh_token: refreshToken
      },
      persistSession
    );
  } catch {
    deleteBrowserAuthCookies();
    return null;
  }
  const user = toUser(gotrueUser);
  startTokenRefresh();
  emitAuthEvent(AUTH_EVENTS.LOGIN, user);
  return user;
};
var toAuthProvider = (value) => typeof value === "string" && AUTH_PROVIDERS.includes(value) ? value : void 0;
var toOptionalString = (value) => typeof value === "string" && value !== "" ? value : void 0;
var toRoles = (appMeta) => {
  const roles = appMeta.roles;
  if (Array.isArray(roles) && roles.every((r) => typeof r === "string")) {
    return roles;
  }
  return void 0;
};
var toUser = (userData) => {
  const userMeta = userData.user_metadata ?? {};
  const appMeta = userData.app_metadata ?? {};
  const name = userMeta.full_name ?? userMeta.name;
  const pictureUrl = userMeta.avatar_url;
  return {
    id: userData.id,
    email: userData.email,
    confirmedAt: toOptionalString(userData.confirmed_at),
    createdAt: userData.created_at,
    updatedAt: userData.updated_at,
    role: toOptionalString(userData.role),
    provider: toAuthProvider(appMeta.provider),
    name: typeof name === "string" ? name : void 0,
    pictureUrl: typeof pictureUrl === "string" ? pictureUrl : void 0,
    roles: toRoles(appMeta),
    invitedAt: toOptionalString(userData.invited_at),
    confirmationSentAt: toOptionalString(userData.confirmation_sent_at),
    recoverySentAt: toOptionalString(userData.recovery_sent_at),
    pendingEmail: toOptionalString(userData.new_email),
    emailChangeSentAt: toOptionalString(userData.email_change_sent_at),
    lastSignInAt: toOptionalString(userData.last_sign_in_at),
    userMetadata: userMeta,
    appMetadata: appMeta
  };
};
var claimsToUser = (claims) => {
  const appMeta = claims.app_metadata ?? {};
  const userMeta = claims.user_metadata ?? {};
  const name = userMeta.full_name ?? userMeta.name;
  const pictureUrl = userMeta.avatar_url;
  return {
    id: claims.sub ?? "",
    email: claims.email,
    provider: toAuthProvider(appMeta.provider),
    name: typeof name === "string" ? name : void 0,
    pictureUrl: typeof pictureUrl === "string" ? pictureUrl : void 0,
    roles: toRoles(appMeta),
    userMetadata: userMeta,
    appMetadata: appMeta
  };
};
var decodeJwtPayload = (token) => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(payload);
  } catch {
    return null;
  }
};
var fetchFullUser = async (identityUrl, jwt) => {
  try {
    const res = await fetchWithTimeout(`${identityUrl}/user`, {
      headers: { Authorization: `Bearer ${jwt}` }
    });
    if (!res.ok) return null;
    const userData = await res.json();
    return toUser(userData);
  } catch {
    return null;
  }
};
var resolveIdentityUrl = () => {
  const identityContext = getIdentityContext();
  if (identityContext?.url) return identityContext.url;
  if (globalThis.Netlify?.context?.url) {
    return new URL(IDENTITY_PATH, globalThis.Netlify.context.url).href;
  }
  const siteUrl = typeof process !== "undefined" ? process.env?.URL : void 0;
  if (siteUrl) {
    return new URL(IDENTITY_PATH, siteUrl).href;
  }
  return null;
};
var getUser = async () => {
  if (isBrowser2()) {
    const client = getGoTrueClient();
    const currentUser2 = client?.currentUser() ?? null;
    if (currentUser2) {
      const jwt2 = getCookie(NF_JWT_COOKIE);
      if (!jwt2) {
        try {
          currentUser2.clearSession();
        } catch {
        }
        return null;
      }
      startTokenRefresh();
      return toUser(currentUser2);
    }
    const jwt = getCookie(NF_JWT_COOKIE);
    if (!jwt) return null;
    const claims2 = decodeJwtPayload(jwt);
    if (!claims2) return null;
    const hydrated = await hydrateSession();
    return hydrated ?? null;
  }
  triggerNextjsDynamic();
  const identityContext = globalThis.netlifyIdentityContext;
  const serverJwt = identityContext?.token ?? getServerCookie(NF_JWT_COOKIE);
  if (serverJwt) {
    const identityUrl = resolveIdentityUrl();
    if (identityUrl) {
      const fullUser = await fetchFullUser(identityUrl, serverJwt);
      if (fullUser) return fullUser;
    }
  }
  const claims = identityContext?.user ?? null;
  return claims ? claimsToUser(claims) : null;
};

// src/app.js
var state = {
  authMode: "login",
  // "login" | "signup"
  view: "auth",
  // "auth" | "list" | "form" | "chat"
  conversations: [],
  // roster from GET /api/characters
  formMode: "create",
  // "create" | "edit"
  editingCharacterId: null,
  character: null,
  // current chat's character info (from /api/me)
  conversationId: null,
  messages: [],
  replyTarget: null,
  pollTimer: null,
  headerTimer: null,
  lastPolledId: null,
  revealing: false
  // true while a typing-reveal animation is in progress
};
var el = (id) => document.getElementById(id);
async function boot() {
  try {
    await handleAuthCallback();
  } catch {
  }
  const user = await getUser().catch(() => null);
  if (user) {
    showList();
  } else {
    showAuth();
  }
}
function showScreen(name) {
  state.view = name;
  el("auth-screen").hidden = name !== "auth";
  el("list-screen").hidden = name !== "list";
  el("form-screen").hidden = name !== "form";
  el("chat-screen").hidden = name !== "chat";
  if (name !== "chat") stopPolling();
}
function showAuth() {
  showScreen("auth");
}
function setAuthError(message) {
  const box = el("auth-error");
  if (!message) {
    box.hidden = true;
    box.textContent = "";
  } else {
    box.hidden = false;
    box.textContent = message;
  }
}
el("auth-toggle-mode").addEventListener("click", () => {
  state.authMode = state.authMode === "login" ? "signup" : "login";
  setAuthError(null);
  el("auth-submit").textContent = state.authMode === "login" ? "Log in" : "Sign up";
  el("auth-toggle-mode").textContent = state.authMode === "login" ? "Need an account? Sign up" : "Already have an account? Log in";
});
el("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setAuthError(null);
  const email = el("auth-email").value.trim();
  const password = el("auth-password").value;
  const submitBtn = el("auth-submit");
  submitBtn.disabled = true;
  try {
    if (state.authMode === "login") {
      await login(email, password);
      showList();
    } else {
      const user = await signup(email, password);
      if (user && (user.confirmedAt || user.confirmed_at)) {
        showList();
      } else {
        setAuthError("Account created! Check your email to confirm it, then log in.");
        state.authMode = "login";
        el("auth-submit").textContent = "Log in";
        el("auth-toggle-mode").textContent = "Need an account? Sign up";
      }
    }
  } catch (err) {
    setAuthError(err?.message || "Something went wrong. Try again.");
  } finally {
    submitBtn.disabled = false;
  }
});
async function doLogout() {
  await logout().catch(() => {
  });
  state.conversations = [];
  state.character = null;
  state.conversationId = null;
  state.messages = [];
  showAuth();
}
el("list-logout-btn").addEventListener("click", doLogout);
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...options.headers || {}
    }
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
    }
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return res.json();
}
async function showList() {
  showScreen("list");
  try {
    const data = await api("/api/characters");
    state.conversations = data.conversations;
    renderConversationList();
  } catch (err) {
    console.error(err);
    if (err.status === 401) showAuth();
  }
}
function timeAgo(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 6e4);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function renderConversationList() {
  const list = el("conversation-list");
  const empty = el("list-empty");
  list.innerHTML = "";
  if (state.conversations.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const convo of state.conversations) {
    const row = document.createElement("button");
    row.className = "conversation-row";
    row.type = "button";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = convo.avatarEmoji || "\u{1F642}";
    row.appendChild(avatar);
    const body = document.createElement("div");
    body.className = "conversation-row-body";
    const top = document.createElement("div");
    top.className = "conversation-row-top";
    const name = document.createElement("span");
    name.className = "conversation-row-name";
    name.textContent = convo.name;
    top.appendChild(name);
    if (convo.lastMessage) {
      const time = document.createElement("span");
      time.className = "conversation-row-time";
      time.textContent = timeAgo(convo.lastMessage.createdAt);
      top.appendChild(time);
    }
    body.appendChild(top);
    const preview = document.createElement("p");
    preview.className = "conversation-row-preview";
    if (convo.lastMessage) {
      const prefix = convo.lastMessage.sender === "user" ? "You: " : "";
      preview.textContent = prefix + convo.lastMessage.content;
    } else {
      preview.textContent = convo.tagline || convo.currentActivity || "say hi";
    }
    body.appendChild(preview);
    row.appendChild(body);
    row.addEventListener("click", () => openConversation(convo.conversationId));
    list.appendChild(row);
  }
}
el("new-character-fab").addEventListener("click", () => openCreateForm());
function resetForm() {
  el("form-seed").value = "";
  el("form-avatar").value = "";
  el("form-name").value = "";
  el("form-tagline").value = "";
  el("form-persona").value = "";
  el("form-style").value = "";
  el("form-activity").value = "";
  el("form-mood").value = "";
  el("form-timezone").value = "";
  setFormError(null);
}
function populateForm(data) {
  el("form-avatar").value = data.avatarEmoji || "";
  el("form-name").value = data.name || "";
  el("form-tagline").value = data.tagline || "";
  el("form-persona").value = data.persona || "";
  el("form-style").value = data.communicationStyle || "";
  el("form-activity").value = data.currentActivity || "";
  el("form-mood").value = data.currentMood || "";
  el("form-timezone").value = data.timezone || "";
}
function setFormError(message) {
  const box = el("form-error");
  if (!message) {
    box.hidden = true;
    box.textContent = "";
  } else {
    box.hidden = false;
    box.textContent = message;
  }
}
function openCreateForm() {
  state.formMode = "create";
  state.editingCharacterId = null;
  el("form-title").textContent = "New character";
  el("form-submit").textContent = "Create character";
  el("generate-block").hidden = false;
  resetForm();
  showScreen("form");
}
function openEditForm() {
  if (!state.character) return;
  const cached = state.conversations.find((c) => c.characterId === state.character.id);
  state.formMode = "edit";
  state.editingCharacterId = state.character.id;
  el("form-title").textContent = "Edit character";
  el("form-submit").textContent = "Save changes";
  el("generate-block").hidden = true;
  setFormError(null);
  populateForm({
    avatarEmoji: state.character.avatarEmoji,
    name: state.character.name,
    tagline: state.character.tagline,
    persona: cached?.persona,
    communicationStyle: cached?.communicationStyle,
    currentActivity: cached?.currentActivity,
    currentMood: cached?.currentMood,
    timezone: cached?.timezone
  });
  showScreen("form");
}
el("chat-edit-btn").addEventListener("click", openEditForm);
el("form-back-btn").addEventListener("click", () => {
  if (state.formMode === "edit" && state.conversationId) {
    showScreen("chat");
    startPolling();
  } else {
    showList();
  }
});
el("generate-btn").addEventListener("click", async () => {
  const btn = el("generate-btn");
  const label = el("generate-btn-label");
  const seedPrompt = el("form-seed").value.trim();
  btn.disabled = true;
  const prevLabel = label.textContent;
  label.textContent = "\u2728 Generating\u2026";
  setFormError(null);
  try {
    const result = await api("/api/generate-character", {
      method: "POST",
      body: JSON.stringify({ seedPrompt })
    });
    populateForm(result.draft);
  } catch (err) {
    console.error(err);
    setFormError(err.message || "Couldn't generate a character. Try again.");
  } finally {
    btn.disabled = false;
    label.textContent = prevLabel;
  }
});
el("character-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setFormError(null);
  const name = el("form-name").value.trim();
  const persona = el("form-persona").value.trim();
  if (!name || !persona) {
    setFormError("Name and persona are required.");
    return;
  }
  const payload = {
    name,
    avatarEmoji: el("form-avatar").value.trim(),
    tagline: el("form-tagline").value.trim(),
    persona,
    communicationStyle: el("form-style").value.trim(),
    currentActivity: el("form-activity").value.trim(),
    currentMood: el("form-mood").value.trim(),
    timezone: el("form-timezone").value.trim()
  };
  const submitBtn = el("form-submit");
  submitBtn.disabled = true;
  try {
    if (state.formMode === "create") {
      const result = await api("/api/characters", { method: "POST", body: JSON.stringify(payload) });
      await showList();
      await openConversation(result.conversationId);
    } else {
      payload.characterId = state.editingCharacterId;
      await api("/api/characters", { method: "PATCH", body: JSON.stringify(payload) });
      await showList();
      if (state.conversationId) await openConversation(state.conversationId);
    }
  } catch (err) {
    console.error(err);
    setFormError(err.message || "Something went wrong. Try again.");
  } finally {
    submitBtn.disabled = false;
  }
});
el("chat-back-btn").addEventListener("click", () => showList());
async function openConversation(conversationId) {
  state.conversationId = conversationId;
  state.messages = [];
  state.replyTarget = null;
  clearReplyPreview();
  el("message-list").innerHTML = "";
  showScreen("chat");
  try {
    const me = await api(`/api/me?conversationId=${encodeURIComponent(conversationId)}`);
    state.character = me.character;
    renderHeader(me.character);
    const data = await api(`/api/messages?conversationId=${encodeURIComponent(conversationId)}`);
    state.messages = data.messages;
    renderAllMessages();
    scrollToBottom();
    startPolling();
  } catch (err) {
    console.error(err);
    if (err.status === 401) showAuth();
    else if (err.status === 404) showList();
  }
}
function renderHeader(character) {
  el("character-avatar").textContent = character.avatarEmoji || "\u{1F642}";
  el("character-name").textContent = character.name;
  el("status-text").textContent = character.currentActivity || "around";
  const dot = el("status-dot");
  const isBusy = Boolean(character.busy);
  dot.classList.toggle("active", !isBusy);
  dot.classList.toggle("busy", isBusy);
}
function renderAllMessages() {
  const list = el("message-list");
  list.innerHTML = "";
  let lastDate = null;
  let lastSender = null;
  for (const msg of state.messages) {
    const dateKey = new Date(msg.createdAt).toDateString();
    if (dateKey !== lastDate) {
      list.appendChild(dateSeparator(msg.createdAt));
      lastDate = dateKey;
      lastSender = null;
    }
    list.appendChild(messageRow(msg, msg.sender === lastSender));
    lastSender = msg.sender;
  }
}
function dateSeparator(iso) {
  const div = document.createElement("div");
  div.className = "date-separator";
  const d = new Date(iso);
  const today = /* @__PURE__ */ new Date();
  const isToday = d.toDateString() === today.toDateString();
  div.textContent = isToday ? "Today" : d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  return div;
}
function findMessage(id) {
  return state.messages.find((m) => m.id === id);
}
function hasMessage(id) {
  return state.messages.some((m) => m.id === id);
}
function messageRow(msg, grouped) {
  const row = document.createElement("div");
  row.className = `msg-row from-${msg.sender}${grouped ? " grouped" : ""}`;
  row.dataset.id = msg.id;
  if (msg.replyToMessageId) {
    const original = findMessage(msg.replyToMessageId);
    if (original) {
      const quote = document.createElement("div");
      quote.className = "reply-quote";
      quote.textContent = original.content;
      row.appendChild(quote);
    }
  }
  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = msg.content;
  wrap.appendChild(bubble);
  const reactionEmoji = msg.sender === "user" ? msg.characterReaction : msg.userReaction;
  if (reactionEmoji) {
    const badge = document.createElement("span");
    badge.className = "reaction-badge";
    badge.textContent = reactionEmoji;
    wrap.appendChild(badge);
  }
  row.appendChild(wrap);
  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const time = new Date(msg.createdAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit"
  });
  if (msg.sender === "user") {
    meta.innerHTML = `<span>${time}</span><span class="${msg.readAt ? "read-ticks" : ""}">${msg.readAt ? "\u2713\u2713" : "\u2713"}</span>`;
  } else {
    meta.textContent = time;
  }
  row.appendChild(meta);
  attachRowInteractions(row, msg);
  return row;
}
function scrollToBottom() {
  const list = el("message-list");
  list.scrollTop = list.scrollHeight;
}
var textarea = el("composer-input");
var sendBtn = el("composer-send");
textarea.addEventListener("input", () => {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
  sendBtn.disabled = textarea.value.trim().length === 0;
});
textarea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    el("composer").requestSubmit();
  }
});
el("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const content = textarea.value.trim();
  if (!content || !state.conversationId) return;
  const replyToMessageId = state.replyTarget?.id || null;
  clearReplyPreview();
  textarea.value = "";
  textarea.style.height = "auto";
  sendBtn.disabled = true;
  const tempId = `temp-${Date.now()}`;
  const optimistic = {
    id: tempId,
    sender: "user",
    content,
    replyToMessageId,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    readAt: null
  };
  state.messages.push(optimistic);
  renderAllMessages();
  scrollToBottom();
  try {
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId: state.conversationId, content, replyToMessageId })
    });
    const idx = state.messages.findIndex((m) => m.id === tempId);
    if (idx !== -1) state.messages[idx] = result.userMessage;
    if (result.reaction) {
      const target = findMessage(result.reaction.messageId);
      if (target) target.characterReaction = result.reaction.emoji;
    }
    renderAllMessages();
    scrollToBottom();
    const lastOfExchange = result.characterMessages.length > 0 ? result.characterMessages[result.characterMessages.length - 1] : result.userMessage;
    state.lastPolledId = lastOfExchange.id;
    await revealCharacterMessages(result.characterMessages);
  } catch (err) {
    console.error(err);
    const idx = state.messages.findIndex((m) => m.id === tempId);
    if (idx !== -1) state.messages.splice(idx, 1);
    renderAllMessages();
  } finally {
    sendBtn.disabled = textarea.value.trim().length === 0;
  }
});
async function revealCharacterMessages(messages) {
  const newOnes = messages.filter((m) => !hasMessage(m.id));
  if (newOnes.length === 0) return;
  state.revealing = true;
  try {
    for (const msg of newOnes) {
      if (hasMessage(msg.id)) continue;
      const typingMs = Math.min(3200, 450 + msg.content.length * 28);
      el("typing-indicator").hidden = false;
      scrollToBottom();
      await sleep(typingMs);
      el("typing-indicator").hidden = true;
      if (hasMessage(msg.id)) continue;
      state.messages.push(msg);
      renderAllMessages();
      scrollToBottom();
    }
  } finally {
    state.revealing = false;
    el("typing-indicator").hidden = true;
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function latestMessageId() {
  if (state.messages.length === 0) return null;
  return state.messages[state.messages.length - 1].id;
}
function setReplyTarget(msg) {
  state.replyTarget = { id: msg.id, snippet: msg.content };
  el("reply-preview").hidden = false;
  el("reply-preview-text").textContent = msg.content;
  textarea.focus();
}
function clearReplyPreview() {
  state.replyTarget = null;
  el("reply-preview").hidden = true;
}
el("reply-preview-cancel").addEventListener("click", clearReplyPreview);
var pressTimer = null;
function attachRowInteractions(row, msg) {
  const start = (e) => {
    if (e.button != null && e.button !== 0) return;
    pressTimer = setTimeout(() => {
      openMessageActions(row, msg);
      pressTimer = null;
    }, 420);
  };
  const cancel = () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  };
  row.addEventListener("pointerdown", start);
  row.addEventListener("pointerup", cancel);
  row.addEventListener("pointerleave", cancel);
  row.addEventListener("pointercancel", cancel);
}
function openMessageActions(row, msg) {
  const picker = el("reaction-picker");
  const replyBtn = el("picker-reply-btn");
  const rect = row.getBoundingClientRect();
  picker.hidden = false;
  picker.style.left = `${Math.min(
    Math.max(rect.left, 12),
    window.innerWidth - picker.offsetWidth - 12
  )}px`;
  picker.style.top = `${rect.top - 52}px`;
  function closePicker() {
    picker.hidden = true;
    picker.removeEventListener("click", onPick);
    replyBtn.removeEventListener("click", onReply);
    document.removeEventListener("pointerdown", dismiss, true);
  }
  const onPick = async (e) => {
    const btn = e.target.closest("button[data-emoji]");
    if (!btn) return;
    closePicker();
    try {
      const result = await api("/api/react", {
        method: "POST",
        body: JSON.stringify({ conversationId: state.conversationId, messageId: msg.id, emoji: btn.dataset.emoji })
      });
      msg.userReaction = result.emoji;
      renderAllMessages();
    } catch (err) {
      console.error(err);
    }
  };
  const onReply = () => {
    closePicker();
    setReplyTarget(msg);
  };
  const dismiss = (e) => {
    if (!picker.contains(e.target)) closePicker();
  };
  picker.addEventListener("click", onPick);
  replyBtn.addEventListener("click", onReply);
  setTimeout(() => document.addEventListener("pointerdown", dismiss, true), 0);
}
function startPolling() {
  stopPolling();
  state.lastPolledId = latestMessageId();
  state.pollTimer = setInterval(pollForNewMessages, 7e3);
  state.headerTimer = setInterval(refreshHeader, 6e4);
  document.addEventListener("visibilitychange", handleVisibility);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.headerTimer) clearInterval(state.headerTimer);
  state.pollTimer = null;
  state.headerTimer = null;
  document.removeEventListener("visibilitychange", handleVisibility);
}
function handleVisibility() {
  if (document.hidden) {
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.headerTimer) clearInterval(state.headerTimer);
    state.pollTimer = null;
    state.headerTimer = null;
  } else if (!state.pollTimer && state.view === "chat") {
    pollForNewMessages();
    refreshHeader();
    state.pollTimer = setInterval(pollForNewMessages, 7e3);
    state.headerTimer = setInterval(refreshHeader, 6e4);
  }
}
async function refreshHeader() {
  if (!state.conversationId) return;
  try {
    const me = await api(`/api/me?conversationId=${encodeURIComponent(state.conversationId)}`);
    state.character = me.character;
    renderHeader(me.character);
  } catch (err) {
    if (err.status === 401) {
      stopPolling();
      showAuth();
    }
  }
}
async function pollForNewMessages() {
  if (!state.lastPolledId || !state.conversationId) return;
  try {
    const data = await api(
      `/api/messages?conversationId=${encodeURIComponent(state.conversationId)}&after_id=${encodeURIComponent(state.lastPolledId)}`
    );
    if (data.messages.length === 0) return;
    state.lastPolledId = data.messages[data.messages.length - 1].id;
    const newMessages = data.messages.filter((m) => !hasMessage(m.id));
    if (newMessages.length === 0) return;
    const characterOnly = newMessages.filter((m) => m.sender === "character");
    const userEchoes = newMessages.filter((m) => m.sender === "user");
    for (const m of userEchoes) {
      if (!hasMessage(m.id)) state.messages.push(m);
    }
    if (characterOnly.length > 0) {
      await revealCharacterMessages(characterOnly);
    } else if (userEchoes.length > 0) {
      renderAllMessages();
      scrollToBottom();
    }
  } catch (err) {
    if (err.status === 401) {
      stopPolling();
      showAuth();
    }
  }
}
boot();
