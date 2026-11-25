local runtime = vim.env.STUDIO_NVIM_RUNTIME
if not runtime or runtime == "" then
	error("Studio document runtime is missing")
end
vim.opt.runtimepath:prepend(runtime)
require("studio_documents").setup()
