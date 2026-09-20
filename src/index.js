// ============================================================
// Google Drive Personal MCP Server
// Cloudflare Worker — zero dependencies, pure JavaScript
// ============================================================

const TOOLS = [
  {
    name: "drive_list",
    description: "List files in a Google Drive folder. Returns file names, IDs, MIME types, and modified dates. Pass folder ID or 'root' for the top level.",
    inputSchema: {
      type: "object",
      properties: {
        folder_id: { type: "string", description: "The Drive folder ID to list. Use 'root' for top-level.", default: "root" },
        page_size: { type: "number", description: "Max results to return (1-1000).", default: 50 },
        page_token: { type: "string", description: "Token for next page of results." }
      }
    }
  },
  {
    name: "drive_search",
    description: "Search Google Drive files by name or full-text content query. Uses Drive's q parameter syntax under the hood.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query — plain text or Drive query syntax (e.g. \"name contains 'report'\")." },
        page_size: { type: "number", description: "Max results (1-1000).", default: 50 },
        page_token: { type: "string", description: "Token for next page of results." }
      },
      required: ["query"]
    }
  },
  {
    name: "drive_get_file",
    description: "Get metadata for a specific file by ID, including name, MIME type, size, parents, sharing info, and web links.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "The Drive file ID." }
      },
      required: ["file_id"]
    }
  },
  {
    name: "drive_read_file",
    description: "Read/export the content of a file. For Google Docs/Sheets/Slides, exports to a requested MIME type. For binary files, returns a temporary download URL.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "The Drive file ID." },
        export_mime: { type: "string", description: "MIME type to export Google Workspace files as. E.g. 'text/plain', 'text/csv', 'application/pdf'. Ignored for non-Workspace files." }
      },
      required: ["file_id"]
    }
  },
  {
    name: "drive_create_folder",
    description: "Create a new folder in Google Drive.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Folder name." },
        parent_id: { type: "string", description: "Parent folder ID. Omit for root.", default: "root" }
      },
      required: ["name"]
    }
  },
  {
    name: "drive_upload",
    description: "Upload a new file to Google Drive. For small files (under 100KB base64). For larger files, use drive_upload_start/part/complete.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name including extension." },
        content: { type: "string", description: "File content — plain text or base64-encoded binary." },
        mime_type: { type: "string", description: "MIME type of the file content.", default: "text/plain" },
        is_base64: { type: "boolean", description: "Set true if content is base64-encoded.", default: false },
        folder_id: { type: "string", description: "Target folder ID. Omit for root.", default: "root" }
      },
      required: ["name", "content"]
    }
  },
  {
    name: "drive_upload_start",
    description: "Start a chunked upload for large files. Returns an upload_id. Then call drive_upload_part one or more times with base64 chunks (up to 200KB each), then drive_upload_complete to finish.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "File name including extension." },
        mime_type: { type: "string", description: "MIME type of the file.", default: "application/octet-stream" },
        folder_id: { type: "string", description: "Target folder ID. Omit for root.", default: "root" }
      },
      required: ["name"]
    }
  },
  {
    name: "drive_upload_part",
    description: "Upload a base64 chunk for an in-progress chunked upload. Call multiple times in order. Each chunk should be up to 200KB of base64 text.",
    inputSchema: {
      type: "object",
      properties: {
        upload_id: { type: "string", description: "The upload_id from drive_upload_start." },
        part_number: { type: "number", description: "Sequential part number starting at 1." },
        content: { type: "string", description: "Base64-encoded chunk of the file." }
      },
      required: ["upload_id", "part_number", "content"]
    }
  },
  {
    name: "drive_upload_complete",
    description: "Complete a chunked upload. Assembles all parts and uploads the file to Google Drive.",
    inputSchema: {
      type: "object",
      properties: {
        upload_id: { type: "string", description: "The upload_id from drive_upload_start." },
        total_parts: { type: "number", description: "Total number of parts uploaded." }
      },
      required: ["upload_id", "total_parts"]
    }
  },
  {
    name: "drive_update",
    description: "Update/replace the content of an existing file by ID. Does not change the file name or location.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "The Drive file ID to update." },
        content: { type: "string", description: "New file content — plain text or base64-encoded binary." },
        mime_type: { type: "string", description: "MIME type of the new content.", default: "text/plain" },
        is_base64: { type: "boolean", description: "Set true if content is base64-encoded.", default: false }
      },
      required: ["file_id", "content"]
    }
  },
  {
    name: "drive_rename",
    description: "Rename a file or folder.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "File or folder ID to rename." },
        new_name: { type: "string", description: "The new name for the file or folder." }
      },
      required: ["file_id", "new_name"]
    }
  },
  {
    name: "drive_share",
    description: "Share a file or folder with a user by email, or make it publicly accessible.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "File or folder ID to share." },
        email: { type: "string", description: "Email address to share with. Omit for public link sharing." },
        role: { type: "string", description: "Permission role: 'reader', 'commenter', or 'writer'.", default: "reader" },
        type: { type: "string", description: "Permission type: 'user', 'group', 'domain', or 'anyone'.", default: "user" }
      },
      required: ["file_id"]
    }
  },
  {
    name: "drive_list_permissions",
    description: "List all permissions (who has access) on a file or folder.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "File or folder ID." }
      },
      required: ["file_id"]
    }
  },
  {
    name: "drive_remove_permission",
    description: "Remove a specific permission from a file or folder. Use drive_list_permissions to get permission IDs first.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "File or folder ID." },
        permission_id: { type: "string", description: "The permission ID to remove." }
      },
      required: ["file_id", "permission_id"]
    }
  },
  {
    name: "drive_delete",
    description: "Move a file or folder to the trash (recoverable) or permanently delete it.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "File or folder ID." },
        permanent: { type: "boolean", description: "If true, permanently delete instead of trashing.", default: false }
      },
      required: ["file_id"]
    }
  },
  {
    name: "drive_untrash",
    description: "Restore a file or folder from the trash.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "File or folder ID to restore." }
      },
      required: ["file_id"]
    }
  },
  {
    name: "drive_move",
    description: "Move a file from one folder to another.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "File ID to move." },
        destination_folder_id: { type: "string", description: "Target folder ID." }
      },
      required: ["file_id", "destination_folder_id"]
    }
  },
  {
    name: "drive_copy",
    description: "Create a copy of a file, optionally in a different folder with a new name.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "Source file ID." },
        name: { type: "string", description: "Name for the copy. Omit to use 'Copy of [original]'." },
        folder_id: { type: "string", description: "Destination folder ID. Omit to place in same folder." }
      },
      required: ["file_id"]
    }
  }
];

const SCOPES = "https://www.googleapis.com/auth/drive";

async function getTokens(env) {
  const raw = await env.GOOGLE_TOKENS.get("tokens");
  return raw ? JSON.parse(raw) : null;
}

async function saveTokens(env, tokens) {
  await env.GOOGLE_TOKENS.put("tokens", JSON.stringify(tokens));
}

async function refreshAccessToken(env) {
  const tokens = await getTokens(env);
  if (!tokens || !tokens.refresh_token) throw new Error("No refresh token. Visit /auth to authorize.");
  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 300000) {
    return tokens.access_token;
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  const updated = {
    access_token: data.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000
  };
  await saveTokens(env, updated);
  return updated.access_token;
}

async function driveAPI(env, path, options = {}) {
  const token = await refreshAccessToken(env);
  const base = env.GOOGLE_API_BASE || "https://www.googleapis.com";
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

async function handleTool(name, args, env) {
  switch (name) {
    case "drive_list": {
      const folderId = args.folder_id || "root";
      const pageSize = Math.min(args.page_size || 50, 1000);
      let q = `'${folderId}' in parents and trashed = false`;
      let url = `/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${pageSize}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size,parents)&orderBy=folder,modifiedTime desc`;
      if (args.page_token) url += `&pageToken=${encodeURIComponent(args.page_token)}`;
      return await driveAPI(env, url);
    }
    case "drive_search": {
      const pageSize = Math.min(args.page_size || 50, 1000);
      let q = args.query;
      if (!q.includes(" in ") && !q.includes("contains") && !q.includes("=")) {
        q = `fullText contains '${q.replace(/'/g, "\\'")}' and trashed = false`;
      } else {
        q += " and trashed = false";
      }
      let url = `/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${pageSize}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size,parents)`;
      if (args.page_token) url += `&pageToken=${encodeURIComponent(args.page_token)}`;
      return await driveAPI(env, url);
    }
    case "drive_get_file": {
      return await driveAPI(env, `/drive/v3/files/${encodeURIComponent(args.file_id)}?fields=id,name,mimeType,size,modifiedTime,createdTime,parents,shared,webViewLink,webContentLink,owners,permissions`);
    }
    case "drive_read_file": {
      const meta = await driveAPI(env, `/drive/v3/files/${encodeURIComponent(args.file_id)}?fields=id,name,mimeType`);
      const mime = meta.mimeType || "";
      if (mime.startsWith("application/vnd.google-apps.")) {
        const exportMime = args.export_mime || (
          mime.includes("document") ? "text/plain" :
          mime.includes("spreadsheet") ? "text/csv" :
          mime.includes("presentation") ? "text/plain" :
          "text/plain"
        );
        const token = await refreshAccessToken(env);
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(args.file_id)}/export?mimeType=${encodeURIComponent(exportMime)}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const text = await res.text();
        return { name: meta.name, mimeType: exportMime, content: text };
      } else {
        return { name: meta.name, mimeType: mime, downloadUrl: `https://www.googleapis.com/drive/v3/files/${args.file_id}?alt=media`, note: "Use this URL with an Authorization header to download." };
      }
    }
    case "drive_create_folder": {
      return await driveAPI(env, "/drive/v3/files?fields=id,name,mimeType,webViewLink", {
        method: "POST",
        body: JSON.stringify({
          name: args.name,
          mimeType: "application/vnd.google-apps.folder",
          parents: [args.parent_id || "root"]
        })
      });
    }
    case "drive_upload": {
      const boundary = "mcp_boundary_" + Date.now();
      const metadata = JSON.stringify({
        name: args.name,
        parents: [args.folder_id || "root"]
      });
      let fileBytes;
      if (args.is_base64) {
        const binaryString = atob(args.content);
        fileBytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) fileBytes[i] = binaryString.charCodeAt(i);
      } else {
        fileBytes = new TextEncoder().encode(args.content);
      }
      const mimeType = args.mime_type || "text/plain";
      const parts = [
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
      ];
      const prefix = new TextEncoder().encode(parts[0] + parts[1]);
      const suffix = new TextEncoder().encode(`\r\n--${boundary}--`);
      const body = new Uint8Array(prefix.length + fileBytes.length + suffix.length);
      body.set(prefix, 0);
      body.set(fileBytes, prefix.length);
      body.set(suffix, prefix.length + fileBytes.length);
      const token = await refreshAccessToken(env);
      const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`
        },
        body: body
      });
      return await res.json();
    }
    case "drive_upload_start": {
      const uploadId = "upload_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      const meta = {
        name: args.name,
        mime_type: args.mime_type || "application/octet-stream",
        folder_id: args.folder_id || "root",
        created: Date.now(),
        parts: 0
      };
      await env.GOOGLE_TOKENS.put(`chunked:${uploadId}:meta`, JSON.stringify(meta), { expirationTtl: 3600 });
      return { upload_id: uploadId, status: "ready", message: "Upload initialized. Send chunks with drive_upload_part, then call drive_upload_complete." };
    }
    case "drive_upload_part": {
      const metaRaw = await env.GOOGLE_TOKENS.get(`chunked:${args.upload_id}:meta`);
      if (!metaRaw) throw new Error("Upload not found or expired. Start a new upload with drive_upload_start.");
      const meta = JSON.parse(metaRaw);
      await env.GOOGLE_TOKENS.put(`chunked:${args.upload_id}:part_${args.part_number}`, args.content, { expirationTtl: 3600 });
      meta.parts = Math.max(meta.parts, args.part_number);
      await env.GOOGLE_TOKENS.put(`chunked:${args.upload_id}:meta`, JSON.stringify(meta), { expirationTtl: 3600 });
      return { upload_id: args.upload_id, part_number: args.part_number, status: "stored", total_parts_so_far: meta.parts };
    }
    case "drive_upload_complete": {
      const metaRaw = await env.GOOGLE_TOKENS.get(`chunked:${args.upload_id}:meta`);
      if (!metaRaw) throw new Error("Upload not found or expired.");
      const meta = JSON.parse(metaRaw);
      let allBase64 = "";
      for (let i = 1; i <= args.total_parts; i++) {
        const chunk = await env.GOOGLE_TOKENS.get(`chunked:${args.upload_id}:part_${i}`);
        if (!chunk) throw new Error(`Missing part ${i}. Upload all parts before completing.`);
        allBase64 += chunk;
      }
      const binaryString = atob(allBase64);
      const fileBytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) fileBytes[i] = binaryString.charCodeAt(i);
      const boundary = "mcp_boundary_" + Date.now();
      const metadata = JSON.stringify({ name: meta.name, parents: [meta.folder_id] });
      const mimeType = meta.mime_type;
      const partStrings = [
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
      ];
      const prefix = new TextEncoder().encode(partStrings[0] + partStrings[1]);
      const suffix = new TextEncoder().encode(`\r\n--${boundary}--`);
      const body = new Uint8Array(prefix.length + fileBytes.length + suffix.length);
      body.set(prefix, 0);
      body.set(fileBytes, prefix.length);
      body.set(suffix, prefix.length + fileBytes.length);
      const token = await refreshAccessToken(env);
      const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,size", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`
        },
        body: body
      });
      const result = await res.json();
      // Clean up KV
      await env.GOOGLE_TOKENS.delete(`chunked:${args.upload_id}:meta`);
      for (let i = 1; i <= args.total_parts; i++) {
        await env.GOOGLE_TOKENS.delete(`chunked:${args.upload_id}:part_${i}`);
      }
      return { ...result, upload_id: args.upload_id, status: "complete", parts_assembled: args.total_parts };
    }
    case "drive_update": {
      const boundary = "mcp_boundary_" + Date.now();
      const metadata = JSON.stringify({});
      let fileBytes;
      if (args.is_base64) {
        const binaryString = atob(args.content);
        fileBytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) fileBytes[i] = binaryString.charCodeAt(i);
      } else {
        fileBytes = new TextEncoder().encode(args.content);
      }
      const mimeType = args.mime_type || "text/plain";
      const parts = [
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
      ];
      const prefix = new TextEncoder().encode(parts[0] + parts[1]);
      const suffix = new TextEncoder().encode(`\r\n--${boundary}--`);
      const body = new Uint8Array(prefix.length + fileBytes.length + suffix.length);
      body.set(prefix, 0);
      body.set(fileBytes, prefix.length);
      body.set(suffix, prefix.length + fileBytes.length);
      const token = await refreshAccessToken(env);
      const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(args.file_id)}?uploadType=multipart&fields=id,name,mimeType,webViewLink,modifiedTime`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`
        },
        body: body
      });
      return await res.json();
    }
    case "drive_rename": {
      return await driveAPI(env, `/drive/v3/files/${encodeURIComponent(args.file_id)}?fields=id,name,mimeType`, {
        method: "PATCH",
        body: JSON.stringify({ name: args.new_name })
      });
    }
    case "drive_share": {
      const permission = {
        role: args.role || "reader",
        type: args.email ? (args.type || "user") : "anyone"
      };
      if (args.email) permission.emailAddress = args.email;
      return await driveAPI(env, `/drive/v3/files/${encodeURIComponent(args.file_id)}/permissions?sendNotificationEmail=false`, {
        method: "POST",
        body: JSON.stringify(permission)
      });
    }
    case "drive_list_permissions": {
      return await driveAPI(env, `/drive/v3/files/${encodeURIComponent(args.file_id)}/permissions?fields=permissions(id,type,role,emailAddress,displayName,domain)`);
    }
    case "drive_remove_permission": {
      return await driveAPI(env, `/drive/v3/files/${encodeURIComponent(args.file_id)}/permissions/${encodeURIComponent(args.permission_id)}`, {
        method: "DELETE"
      });
    }
    case "drive_delete": {
      if (args.permanent) {
        return await driveAPI(env, `/drive/v3/files/${encodeURIComponent(args.file_id)}`, { method: "DELETE" });
      } else {
        return await driveAPI(env, `/drive/v3/files/${encodeURIComponent(args.file_id)}`, {
          method: "PATCH",
          body: JSON.stringify({ trashed: true })
        });
      }
    }
    case "drive_untrash": {
      return await driveAPI(env, `/drive/v3/files/${encodeURIComponent(args.file_id)}?fields=id,name,mimeType,parents`, {
        method: "PATCH",
        body: JSON.stringify({ trashed: false })
      });
    }
    case "drive_move": {
      const meta = await driveAPI(env, `/drive/v3/files/${encodeURIComponent(args.file_id)}?fields=parents`);
      const oldParents = (meta.parents || []).join(",");
      return await driveAPI(env, `/drive/v3/files/${encodeURIComponent(args.file_id)}?addParents=${encodeURIComponent(args.destination_folder_id)}&removeParents=${encodeURIComponent(oldParents)}&fields=id,name,parents`, {
        method: "PATCH",
        body: JSON.stringify({})
      });
    }
    case "drive_copy": {
      const body = {};
      if (args.name) body.name = args.name;
      if (args.folder_id) body.parents = [args.folder_id];
      return await driveAPI(env, `/drive/v3/files/${encodeURIComponent(args.file_id)}/copy?fields=id,name,mimeType,webViewLink`, {
        method: "POST",
        body: JSON.stringify(body)
      });
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function handleMCP(request, env) {
  const body = await request.json();
  const { method, params, id } = body;
  switch (method) {
    case "initialize":
      return jsonRPC(id, {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "google-drive-personal-mcp", version: "1.0.0" },
        capabilities: { tools: { listChanged: false } }
      });
    case "notifications/initialized":
      return new Response("", { status: 204 });
    case "tools/list":
      return jsonRPC(id, { tools: TOOLS });
    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const result = await handleTool(toolName, toolArgs, env);
        return jsonRPC(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        return jsonRPC(id, { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
      }
    }
    case "ping":
      return jsonRPC(id, {});
    default:
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }), { headers: { "Content-Type": "application/json" } });
  }
}

function jsonRPC(id, result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "Content-Type": "application/json" } });
}

function handleAuth(env) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent"
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) return new Response("Missing code parameter", { status: 400 });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET
    })
  });
  const data = await res.json();
  if (data.error) {
    return new Response(`OAuth error: ${data.error_description || data.error}`, { status: 400 });
  }
  await saveTokens(env, {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000
  });
  return new Response("Authorization successful! Tokens saved. You can close this tab.", {
    headers: { "Content-Type": "text/plain" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/health") return new Response("OK", { status: 200 });
    if (path === "/auth") return handleAuth(env);
    if (path === "/callback") return handleCallback(request, env);
    const authHeader = request.headers.get("Authorization") || "";
    const expected = `Bearer ${env.MCP_AUTH_TOKEN}`;
    if (authHeader !== expected) return new Response("Unauthorized", { status: 401 });
    if (path === "/mcp" && request.method === "POST") return handleMCP(request, env);
    return new Response("Not found", { status: 404 });
  }
};
