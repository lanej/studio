local M = {}
local uv = vim.uv or vim.loop
local namespace = vim.api.nvim_create_namespace("StudioDocuments")
local update_namespace = vim.api.nvim_create_namespace("StudioDocumentUpdates")
local boundary_namespace = vim.api.nvim_create_namespace("StudioDocumentBoundaries")
local state = {
	documents = {},
	buffers = {},
	feedback = {},
	requests = {},
	windows = {},
	sequence = 0,
	epoch = 0,
	stopped = true,
}
local max_frame = 4 * 1024 * 1024
local timeout_ms = 5000

local function notify(message, level)
	vim.notify("Studio: " .. message, level or vim.log.levels.INFO)
end

local function id()
	state.sequence = state.sequence + 1
	return string.format("%x-%x-%x", vim.fn.getpid(), uv.hrtime(), state.sequence)
end

local function key(ref)
	return table.concat({ ref.ownerKind, ref.ownerId, ref.conversationId, ref.project, ref.kind }, "\0")
end

local function valid_ref(ref)
	if type(ref) ~= "table" then
		return false
	end
	for _, name in ipairs({ "ownerKind", "ownerId", "conversationId", "project", "kind" }) do
		if type(ref[name]) ~= "string" or ref[name] == "" then
			return false
		end
	end
	return (ref.ownerKind == "discovery" or ref.ownerKind == "attempt")
		and (ref.kind == "specification" or ref.kind == "plan")
end

local function valid_snapshot(snapshot)
	return type(snapshot) == "table"
		and valid_ref(snapshot.ref)
		and type(snapshot.revision) == "string"
		and type(snapshot.markdown) == "string"
		and type(snapshot.writable) == "boolean"
end

local function buffer_text(buffer)
	local value = table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), "\n")
	return value .. (vim.bo[buffer].endofline and "\n" or "")
end

local function lines_of(text)
	local lines = vim.split(text, "\n", { plain = true })
	local eol = text:sub(-1) == "\n"
	if eol then
		table.remove(lines)
	end
	if #lines == 0 then
		lines = { "" }
	end
	return lines, eol
end

local function each_document(callback)
	for _, document in pairs(state.documents) do
		if vim.api.nvim_buf_is_valid(document.buffer) then
			callback(document)
		end
	end
end

local function request(method, params, callback)
	if state.stopped then
		callback(nil, { code = "disconnected", message = "Document connection is closed" })
		return
	end
	local request_id = id()
	local pipe, timer = uv.new_pipe(false), uv.new_timer()
	local completed, incoming = false, ""
	local function finish(result, err)
		if completed then
			return
		end
		completed = true
		state.requests[request_id] = nil
		if not timer:is_closing() then
			timer:stop()
			timer:close()
		end
		if not pipe:is_closing() then
			pipe:read_stop()
			pipe:close()
		end
		vim.schedule(function()
			callback(result, err)
		end)
	end
	state.requests[request_id] = function()
		finish(nil, { code = "disconnected", message = "Document connection is closed" })
	end
	timer:start(timeout_ms, 0, function()
		finish(nil, { code = "uncertain", message = "No acknowledgment; the operation may have been accepted" })
	end)
	local connection = state.connection
	pipe:connect(connection.socket, function(connect_error)
		if completed then
			return
		end
		if connect_error then
			finish(nil, { code = "disconnected", message = "Cannot reach the bound Studio session" })
			return
		end
		pipe:read_start(function(read_error, chunk)
			if completed then
				return
			end
			if read_error then
				finish(nil, { code = "uncertain", message = "Connection failed before acknowledgment" })
				return
			end
			if chunk == nil then
				finish(nil, { code = "uncertain", message = "Connection closed before acknowledgment" })
				return
			end
			incoming = incoming .. chunk
			if #incoming > max_frame then
				finish(nil, { code = "protocol", message = "Studio reply exceeds the document limit" })
				return
			end
			local newline = incoming:find("\n", 1, true)
			if not newline then
				return
			end
			local decoded, reply = pcall(vim.json.decode, incoming:sub(1, newline - 1))
			if not decoded or type(reply) ~= "table" or reply.id ~= request_id or type(reply.ok) ~= "boolean" then
				finish(nil, { code = "protocol", message = "Invalid acknowledgment from Studio" })
				return
			end
			if reply.ok then
				finish(reply.result)
			else
				local err = reply.error
				if type(err) ~= "table" or type(err.message) ~= "string" then
					err = { code = "protocol", message = "Invalid error acknowledgment from Studio" }
				end
				finish(nil, err)
			end
		end)
		local encoded = vim.json.encode({
			id = request_id,
			token = connection.token,
			generation = connection.generation,
			method = method,
			params = params,
		})
		if #encoded > max_frame then
			finish(nil, { code = "invalid", message = "Document request exceeds the size limit" })
			return
		end
		pipe:write(encoded .. "\n", function(write_error)
			if write_error then
				finish(nil, { code = "uncertain", message = "Write failed before acknowledgment" })
			end
		end)
	end)
end

local function document_for(buffer)
	return state.buffers[buffer or vim.api.nvim_get_current_buf()]
end

local function require_document()
	local document = document_for()
	if not document then
		notify("This buffer is not a Studio document", vim.log.levels.WARN)
	end
	return document
end

local function status(document, compact)
	if not state.connected then
		return "disconnected"
	end
	if document.detached then
		return "inactive document"
	end
	if document.saving then
		return "saving"
	end
	if document.save then
		return compact and "save unconfirmed" or "save unconfirmed — :write to reconcile"
	end
	if document.incoming then
		return compact and "conflict" or "conflict — :StudioCompare"
	end
	if not document.writable then
		return compact and "protected" or document.reason or "protected — reopen in Studio"
	end
	if vim.bo[document.buffer].modified then
		return "unsaved"
	end
	return document.updated and "updated" or "saved"
end

local feedback_labels = {
	queued = "Queued",
	dispatching = "Sending",
	awaiting = "Awaiting response",
	parked = "Parked",
	answered = "Answered",
	failed = "Failed",
	uncertain = "Unconfirmed",
}

local function selection_line(buffer, feedback)
	local selected = vim.split(feedback.selectedText or "", "\n", { plain = true })
	local lines = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
	local found
	for start = 1, #lines - #selected + 1 do
		local matches = true
		for offset, line in ipairs(selected) do
			if lines[start + offset - 1] ~= line then
				matches = false
				break
			end
		end
		if matches then
			if found then
				return 0, true
			end
			found = start - 1
		end
	end
	return found or 0, found == nil
end

local function restore_window(window)
	local previous = state.windows[window]
	if previous and vim.api.nvim_win_is_valid(window) then
		vim.wo[window].conceallevel = previous.conceallevel
		vim.wo[window].concealcursor = previous.concealcursor
		vim.wo[window].winbar = previous.winbar
	end
	state.windows[window] = nil
end

local function window_status(window, document)
	local label = " Studio · " .. status(document, true) .. " · " .. document.ref.kind
	local highlight = document.incoming and "StudioDocumentPending" or "StudioDocumentStatus"
	vim.wo[window].winbar = "%#" .. highlight .. "#" .. label:gsub("%%", "%%%%")
end

local function enter_document_window(buffer)
	local window = vim.api.nvim_get_current_win()
	if state.windows[window] and state.windows[window].buffer == buffer then
		return
	end
	restore_window(window)
	local previous = {
		buffer = buffer,
		conceallevel = vim.wo[window].conceallevel,
		concealcursor = vim.wo[window].concealcursor,
		winbar = vim.wo[window].winbar,
	}
	-- A split inherits the document window's temporary options, not its baseline.
	for _, other in pairs(state.windows) do
		if other.buffer == buffer then
			previous.conceallevel, previous.concealcursor = other.conceallevel, other.concealcursor
			previous.winbar = other.winbar
			break
		end
	end
	state.windows[window] = previous
	vim.wo[window].conceallevel, vim.wo[window].concealcursor = 2, "nc"
	window_status(window, state.buffers[buffer])
end

local function conceal_boundaries(document)
	local buffer = document.buffer
	local changedtick = vim.api.nvim_buf_get_changedtick(buffer)
	if document.boundary_tick == changedtick then
		return
	end
	document.boundary_tick = changedtick
	vim.api.nvim_buf_clear_namespace(buffer, boundary_namespace, 0, -1)
	local lines = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
	local kind, token = (lines[2] or ""):match("^<!%-%- studio%-document:v1:(%a+):([a-f0-9]+) %-%->$")
	if kind ~= document.ref.kind or not token or #token ~= 16 then
		return
	end
	for index, line in ipairs(lines) do
		if
			index == 2
			or line == "<!-- /studio:" .. token .. " -->"
			or line:match("^<!%-%- studio:" .. token .. ":[a-zA-Z0-9/%-]+ %-%->$")
		then
			local options = { end_col = #line, conceal = "" }
			if vim.fn.has("nvim-0.11") == 1 then
				options.conceal_lines = ""
			end
			vim.api.nvim_buf_set_extmark(buffer, boundary_namespace, index - 1, 0, options)
		end
	end
end

local function render(document)
	local buffer = document.buffer
	if not vim.api.nvim_buf_is_valid(buffer) then
		return
	end
	conceal_boundaries(document)
	vim.api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
	for _, window in ipairs(vim.fn.win_findbuf(buffer)) do
		if state.windows[window] then
			window_status(window, document)
		end
	end
	for _, feedback in pairs(state.feedback) do
		if valid_ref(feedback.ref) and key(feedback.ref) == document.key then
			local line, stale = selection_line(buffer, feedback)
			local label = feedback_labels[feedback.state] or "Unknown"
			if feedback.state == "answered" and feedback.summary then
				label = label .. " · " .. feedback.summary
			end
			if feedback.state == "answered" and #(feedback.changes or {}) == 0 then
				label = label .. " · no document edits"
			end
			if stale then
				label = label .. " · original selection moved"
			end
			if document.incoming and feedback.state == "answered" then
				label = label .. " · update held"
			end
			vim.api.nvim_buf_set_extmark(buffer, namespace, line, 0, {
				virt_text = {
					{
						"  " .. label:gsub("[\r\n]", " "),
						feedback.state == "answered" and "StudioDocumentAnswer" or "StudioDocumentPending",
					},
				},
				virt_text_pos = "eol",
			})
		end
	end
end

local function retain_views(buffer)
	local views = {}
	for _, window in ipairs(vim.fn.win_findbuf(buffer)) do
		if vim.api.nvim_win_is_valid(window) then
			views[window] = vim.api.nvim_win_call(window, vim.fn.winsaveview)
		end
	end
	return function()
		for window, view in pairs(views) do
			if vim.api.nvim_win_is_valid(window) and vim.api.nvim_win_get_buf(window) == buffer then
				pcall(vim.api.nvim_win_call, window, function()
					vim.fn.winrestview(view)
				end)
			end
		end
	end
end

local function set_text(document, markdown, clean)
	local buffer = document.buffer
	local restore = retain_views(buffer)
	local lines, eol = lines_of(markdown)
	vim.bo[buffer].modifiable = true
	vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
	vim.bo[buffer].endofline = eol
	vim.bo[buffer].modified = not clean
	vim.bo[buffer].modifiable = document.writable or not clean
	restore()
end

local function apply_snapshot(document, snapshot, force)
	if key(snapshot.ref) ~= document.key then
		error("Studio document identity changed")
	end
	document.detached = false
	document.writable, document.reason = snapshot.writable, snapshot.reason
	vim.bo[document.buffer].modifiable = snapshot.writable or vim.bo[document.buffer].modified
	if snapshot.revision == document.revision then
		render(document)
		return
	end
	if (vim.bo[document.buffer].modified or document.save) and not force then
		document.incoming = snapshot
		render(document)
		return
	end
	local first = document.revision == nil
	document.revision, document.markdown = snapshot.revision, snapshot.markdown
	document.incoming = nil
	set_text(document, snapshot.markdown, true)
	document.updated = not first
	if not first then
		vim.api.nvim_buf_clear_namespace(document.buffer, update_namespace, 0, -1)
		vim.api.nvim_buf_set_extmark(document.buffer, update_namespace, 0, 0, {
			sign_text = "↻",
			sign_hl_group = "StudioDocumentAnswer",
		})
	end
	render(document)
end

local function save_document(document)
	if document.saving then
		notify("A save is awaiting acknowledgment")
		return
	end
	if document.detached then
		notify("Return to this document's discovery in Studio before saving", vim.log.levels.WARN)
		return
	end
	if not document.writable and not document.save then
		notify(document.reason or "Reopen this document in Studio before editing", vim.log.levels.WARN)
		return
	end
	if document.incoming and not document.save then
		notify("Compare and reconcile the incoming revision before saving", vim.log.levels.WARN)
		return
	end
	local buffer = document.buffer
	local pending = document.save
		or {
			operationId = id(),
			ref = vim.deepcopy(document.ref),
			expectedRevision = document.revision,
			markdown = buffer_text(buffer),
			changedtick = vim.api.nvim_buf_get_changedtick(buffer),
		}
	document.save, document.saving = pending, true
	state.epoch = state.epoch + 1
	render(document)
	request("save", {
		operationId = pending.operationId,
		ref = pending.ref,
		expectedRevision = pending.expectedRevision,
		markdown = pending.markdown,
	}, function(snapshot, err)
		document.saving = false
		state.epoch = state.epoch + 1
		if state.stopped then
			return
		end
		if not vim.api.nvim_buf_is_valid(buffer) then
			return
		end
		if err then
			if err.code ~= "uncertain" and err.code ~= "disconnected" and err.code ~= "protocol" then
				document.save = nil
			end
			notify(err.message .. (document.save and "; :write retries this same save" or ""), vim.log.levels.WARN)
			render(document)
			return
		end
		if not valid_snapshot(snapshot) or key(snapshot.ref) ~= document.key then
			notify("Save acknowledgment has the wrong document identity", vim.log.levels.ERROR)
			render(document)
			return
		end
		document.save = nil
		document.revision, document.markdown = snapshot.revision, snapshot.markdown
		document.writable, document.reason = snapshot.writable, snapshot.reason
		local unchanged = vim.api.nvim_buf_get_changedtick(buffer) == pending.changedtick
			and buffer_text(buffer) == pending.markdown
		if unchanged then
			set_text(document, snapshot.markdown, true)
		else
			vim.bo[buffer].modified = true
			notify("Submitted revision saved; newer buffer edits remain unsaved")
		end
		if document.incoming and document.incoming.revision == snapshot.revision then
			document.incoming = nil
		end
		document.updated = false
		render(document)
		vim.api.nvim_exec_autocmds("BufWritePost", { buffer = buffer, modeline = false })
	end)
end

local function create_document(snapshot)
	local document_key = key(snapshot.ref)
	local buffer = vim.api.nvim_create_buf(true, false)
	local document =
		{ key = document_key, buffer = buffer, ref = vim.deepcopy(snapshot.ref), writable = snapshot.writable }
	state.documents[document_key], state.buffers[buffer] = document, document
	local path = snapshot.path
	if type(path) ~= "string" or path:sub(1, 1) ~= "/" then
		path = "studio://" .. snapshot.ref.ownerId .. "/" .. snapshot.ref.kind .. ".md"
	end
	if vim.fn.bufnr(path) ~= -1 then
		path = "studio://"
			.. snapshot.ref.conversationId
			.. "/"
			.. snapshot.ref.ownerId
			.. "/"
			.. snapshot.ref.kind
			.. ".md"
	end
	vim.api.nvim_buf_set_name(buffer, path)
	vim.bo[buffer].buftype, vim.bo[buffer].bufhidden = "acwrite", "hide"
	vim.bo[buffer].swapfile, vim.bo[buffer].modeline = false, false
	vim.bo[buffer].filetype = "markdown"
	vim.bo[buffer].undofile = false
	vim.b[buffer].studio_document_ref = vim.deepcopy(snapshot.ref)
	vim.api.nvim_create_autocmd({ "BufEnter", "BufWinEnter" }, {
		group = state.group,
		buffer = buffer,
		callback = function()
			enter_document_window(buffer)
		end,
	})
	vim.api.nvim_create_autocmd("BufWinLeave", {
		group = state.group,
		buffer = buffer,
		callback = function()
			restore_window(vim.api.nvim_get_current_win())
		end,
	})
	vim.api.nvim_create_autocmd("BufWriteCmd", {
		group = state.group,
		buffer = buffer,
		callback = function()
			save_document(document)
		end,
	})
	vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI", "BufEnter" }, {
		group = state.group,
		buffer = buffer,
		callback = function()
			render(document)
		end,
	})
	vim.keymap.set(
		{ "n", "x" },
		"<localleader>sc",
		":StudioComment<CR>",
		{ buffer = buffer, desc = "Send Studio document comment" }
	)
	vim.keymap.set(
		"n",
		"<localleader>sr",
		"<Cmd>StudioResponses<CR>",
		{ buffer = buffer, desc = "Inspect Studio responses" }
	)
	vim.keymap.set(
		"n",
		"<localleader>sd",
		"<Cmd>StudioChanges<CR>",
		{ buffer = buffer, desc = "Jump to Studio changes" }
	)
	apply_snapshot(document, snapshot, true)
	if not state.opened then
		state.opened = true
		local current = vim.api.nvim_get_current_buf()
		if not vim.bo[current].modified then
			vim.bo[current].bufhidden = "hide"
			vim.api.nvim_set_current_buf(buffer)
		end
	end
	return document
end

local function update_feedback(records)
	for _, feedback in ipairs(records) do
		if type(feedback) == "table" and type(feedback.requestId) == "string" and valid_ref(feedback.ref) then
			state.feedback[feedback.requestId] = feedback
		end
	end
end

function M.sync()
	if state.stopped or state.syncing then
		return
	end
	-- A read started before a save acknowledgment cannot establish the new base.
	for _, document in pairs(state.documents) do
		if document.saving then
			return
		end
	end
	state.syncing = true
	local epoch = state.epoch
	request("sync", {}, function(result, err)
		state.syncing = false
		if state.stopped then
			return
		end
		if state.epoch ~= epoch then
			return
		end
		if err then
			if state.connected then
				notify(err.message, vim.log.levels.WARN)
			end
			state.connected = false
			each_document(render)
			return
		end
		if type(result) ~= "table" or type(result.documents) ~= "table" or type(result.feedback) ~= "table" then
			if state.connected then
				notify("Invalid synchronization reply", vim.log.levels.ERROR)
			end
			state.connected = false
			each_document(render)
			return
		end
		state.connected = true
		local seen = {}
		for _, snapshot in ipairs(result.documents) do
			if valid_snapshot(snapshot) then
				local document_key = key(snapshot.ref)
				seen[document_key] = true
				local document = state.documents[document_key]
				if not document or not vim.api.nvim_buf_is_valid(document.buffer) then
					create_document(snapshot)
				else
					apply_snapshot(document, snapshot, false)
				end
			end
		end
		update_feedback(result.feedback)
		each_document(function(document)
			document.detached = not seen[document.key]
			render(document)
		end)
	end)
end

local function show_document(document, line)
	if not vim.api.nvim_buf_is_valid(document.buffer) then
		notify("Document buffer is no longer open", vim.log.levels.WARN)
		return
	end
	vim.api.nvim_set_current_buf(document.buffer)
	if line then
		vim.api.nvim_win_set_cursor(0, { math.min(math.max(line, 1), vim.api.nvim_buf_line_count(document.buffer)), 0 })
		vim.cmd("normal! zv")
	end
end

local function document_list()
	local list = {}
	each_document(function(document)
		table.insert(list, document)
	end)
	table.sort(list, function(a, b)
		return a.key < b.key
	end)
	return list
end

local function feedback_list(document)
	local list = {}
	for _, feedback in pairs(state.feedback) do
		if not document or key(feedback.ref) == document.key then
			table.insert(list, feedback)
		end
	end
	table.sort(list, function(a, b)
		return a.requestId < b.requestId
	end)
	return list
end

local function choose_feedback(callback)
	local document = require_document()
	if not document then
		return
	end
	local list = feedback_list(document)
	if #list == 0 then
		notify("No comments on this document")
		return
	end
	vim.ui.select(list, {
		prompt = "Studio comments",
		format_item = function(item)
			return (feedback_labels[item.state] or item.state) .. " · " .. item.message:gsub("[\r\n]", " ")
		end,
	}, callback)
end

local function show_changes(feedback)
	if not feedback then
		return
	end
	local changes = feedback.changes or {}
	if #changes == 0 then
		local status = feedback.state == "answered" and "No document edits. " or "No document edits recorded. "
		notify(status .. (feedback.summary or feedback.reason or ""))
		return
	end
	vim.ui.select(changes, {
		prompt = "Changed document locations",
		format_item = function(change)
			return change.ref.kind
				.. " · "
				.. (change.sectionId or ("line " .. tostring((change.range or {}).startLine or 1)))
		end,
	}, function(change)
		if not change then
			return
		end
		local document = state.documents[key(change.ref)]
		if not document then
			notify("That document is not available in this editor", vim.log.levels.WARN)
			return
		end
		if document.revision ~= change.afterRevision or document.incoming or vim.bo[document.buffer].modified then
			notify(
				"Change location belongs to another revision; inspect the response and current document",
				vim.log.levels.WARN
			)
			return
		end
		show_document(document, (change.range or {}).startLine or 1)
	end)
end

function M.comment(first_line, last_line, supplied_message)
	local document = require_document()
	if not document then
		return
	end
	if document.detached then
		notify("Return to this discovery in Studio before commenting", vim.log.levels.WARN)
		return
	end
	local buffer = document.buffer
	local count = vim.api.nvim_buf_line_count(buffer)
	first_line = math.max(1, math.min(first_line or vim.fn.line("."), count))
	last_line = math.max(first_line, math.min(last_line or first_line, count))
	local request_value = {
		requestId = id(),
		ref = vim.deepcopy(document.ref),
		baseRevision = document.revision,
		bufferIdentity = vim.fn.sha256(buffer_text(buffer)),
		range = { startLine = first_line, endLine = last_line },
		selectedText = table.concat(vim.api.nvim_buf_get_lines(buffer, first_line - 1, last_line, false), "\n"),
	}
	local function submit(message)
		if message == nil or message:match("^%s*$") then
			return
		end
		request_value.message = message
		local local_record = vim.deepcopy(request_value)
		local_record.state = "dispatching"
		state.feedback[request_value.requestId] = local_record
		render(document)
		request("feedback", request_value, function(record, err)
			if err then
				local_record.state = (err.code == "uncertain" or err.code == "disconnected") and "uncertain" or "failed"
				local_record.reason = err.message
				notify(err.message, vim.log.levels.WARN)
			elseif
				type(record) == "table"
				and record.requestId == request_value.requestId
				and valid_ref(record.ref)
				and key(record.ref) == document.key
			then
				state.feedback[record.requestId] = record
			else
				local_record.state, local_record.reason = "uncertain", "Invalid feedback acknowledgment"
			end
			render(document)
		end)
	end
	if supplied_message ~= nil then
		submit(supplied_message)
	else
		vim.ui.input({ prompt = "Studio comment: " }, submit)
	end
end

function M.compare()
	local document = require_document()
	if not document then
		return
	end
	if not document.incoming then
		notify("No incoming conflict to compare")
		return
	end
	local incoming = document.incoming
	local local_window = vim.api.nvim_get_current_win()
	vim.cmd("vsplit")
	local incoming_window = vim.api.nvim_get_current_win()
	local buffer = vim.api.nvim_create_buf(false, true)
	vim.api.nvim_buf_set_name(buffer, "studio-incoming://" .. id() .. "/" .. document.ref.kind .. ".md")
	vim.api.nvim_win_set_buf(incoming_window, buffer)
	local lines = lines_of(incoming.markdown)
	vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
	vim.bo[buffer].filetype, vim.bo[buffer].bufhidden = "markdown", "wipe"
	vim.bo[buffer].modifiable = false
	vim.api.nvim_win_call(local_window, function()
		vim.cmd("diffthis")
	end)
	vim.cmd("diffthis")
	document.comparedRevision = incoming.revision
	vim.api.nvim_set_current_win(local_window)
	notify("Local edits left; incoming revision right. Merge locally, then :StudioResolve and :write")
end

function M.resolve()
	local document = require_document()
	if not document or not document.incoming then
		return
	end
	if document.save then
		notify("Reconcile the pending save with :write first", vim.log.levels.WARN)
		return
	end
	if document.comparedRevision ~= document.incoming.revision then
		notify("Inspect this incoming revision with :StudioCompare first", vim.log.levels.WARN)
		return
	end
	document.revision, document.markdown = document.incoming.revision, document.incoming.markdown
	document.writable, document.reason = document.incoming.writable, document.incoming.reason
	document.incoming, document.comparedRevision = nil, nil
	vim.bo[document.buffer].modified = true
	vim.bo[document.buffer].modifiable = true
	render(document)
	notify("Merged buffer is based on the incoming revision; :write saves it")
end

function M.reload(force)
	local document = require_document()
	if not document then
		return
	end
	if document.save then
		notify("Reconcile the pending save with :write first", vim.log.levels.WARN)
		return
	end
	if not force then
		notify("Use :StudioReload! to discard local edits, or :StudioCompare to merge", vim.log.levels.WARN)
		return
	end
	local snapshot = document.incoming
		or {
			ref = document.ref,
			revision = document.revision,
			markdown = document.markdown,
			writable = document.writable,
			reason = document.reason,
		}
	document.revision = nil
	apply_snapshot(document, snapshot, true)
end

function M.stop()
	state.stopped = true
	for window in pairs(state.windows) do
		restore_window(window)
	end
	if state.timer and not state.timer:is_closing() then
		state.timer:stop()
		state.timer:close()
	end
	local requests = vim.tbl_values(state.requests)
	for _, cancel in ipairs(requests) do
		cancel()
	end
end

function M.setup(connection)
	if not state.stopped then
		return
	end
	if not connection then
		local path = vim.env.STUDIO_DOCUMENT_CONNECTION
		if not path or path == "" then
			error("Studio document connection manifest is missing")
		end
		local ok, decoded = pcall(vim.json.decode, table.concat(vim.fn.readfile(path), "\n"))
		if not ok then
			error("Invalid Studio document connection manifest")
		end
		connection = decoded
	end
	if
		type(connection) ~= "table"
		or type(connection.socket) ~= "string"
		or type(connection.token) ~= "string"
		or type(connection.generation) ~= "string"
	then
		error("Incomplete Studio document connection manifest")
	end
	state.connection, state.stopped, state.connected = vim.deepcopy(connection), false, false
	state.group = vim.api.nvim_create_augroup("StudioDocuments", { clear = true })
	vim.api.nvim_set_hl(0, "StudioDocumentStatus", { link = "Comment", default = true })
	vim.api.nvim_set_hl(0, "StudioDocumentPending", { link = "DiagnosticWarn", default = true })
	vim.api.nvim_set_hl(0, "StudioDocumentAnswer", { link = "DiagnosticInfo", default = true })
	vim.api.nvim_create_user_command("StudioDocuments", function()
		vim.ui.select(document_list(), {
			prompt = "Studio documents",
			format_item = function(document)
				return document.ref.kind
					.. " · "
					.. vim.fn.fnamemodify(document.ref.project, ":t")
					.. " · "
					.. document.ref.ownerId:sub(1, 8)
					.. " · "
					.. status(document)
			end,
		}, function(document)
			if document then
				show_document(document)
			end
		end)
	end, {})
	vim.api.nvim_create_user_command("StudioComment", function(options)
		M.comment(options.line1, options.line2)
	end, { range = true })
	vim.api.nvim_create_user_command("StudioResponses", function()
		choose_feedback(function(feedback)
			if not feedback then
				return
			end
			notify(
				(feedback.summary or feedback.reason or feedback_labels[feedback.state] or feedback.state)
					.. "\nOriginal selection:\n"
					.. feedback.selectedText
			)
		end)
	end, {})
	vim.api.nvim_create_user_command("StudioChanges", function()
		choose_feedback(show_changes)
	end, {})
	vim.api.nvim_create_user_command("StudioCompare", M.compare, {})
	vim.api.nvim_create_user_command("StudioResolve", M.resolve, {})
	vim.api.nvim_create_user_command("StudioReload", function(options)
		M.reload(options.bang)
	end, { bang = true })
	vim.api.nvim_create_autocmd("VimLeavePre", { group = state.group, callback = M.stop })
	vim.api.nvim_create_autocmd("WinClosed", {
		group = state.group,
		callback = function(event)
			state.windows[tonumber(event.match)] = nil
		end,
	})
	state.timer = uv.new_timer()
	state.timer:start(0, 500, vim.schedule_wrap(M.sync))
	request("register", {
		pid = vim.fn.getpid(),
		socket = vim.v.servername,
		pane = vim.env.ZELLIJ_PANE_ID,
		session = vim.env.ZELLIJ_SESSION_NAME,
	}, function(_, err)
		if err then
			notify(err.message, vim.log.levels.WARN)
		end
	end)
end

return M
