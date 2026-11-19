/**
 * Local `defineTool` shim.
 *
 * The upstream package imported `defineTool` from `@deepseek-ai/dsh-tools`, but a
 * linked plugin cannot resolve that package at runtime (it lives inside the DSH
 * CLI installation, not in the profile's node_modules). The helper only
 * normalizes the author-facing schema shorthand into the raw JSON Schema subset
 * the tool registry enforces, so we reimplement that small piece here.
 *
 * Shorthand accepted (same as upstream):
 *   parameters: { url: { type: 'string', required: true, description: '...' } }
 *   output:     { schema: { type: 'json' }, render: (args, value) => [...] }
 */

/** Author-facing type names → raw JSON Schema nodes. */
const SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'null'])

function compileNode(spec) {
  if (spec === undefined || spec === null || typeof spec !== 'object') {
    throw new Error(`defineTool: unsupported schema node ${JSON.stringify(spec)}`)
  }
  if (spec.type === 'json') return {}
  if (Array.isArray(spec.oneOf)) {
    return { oneOf: spec.oneOf.map((branch) => compileNode(branch)) }
  }
  if (spec.type === 'object' || (spec.properties !== undefined && spec.type === undefined)) {
    const compiled = compilePropertyMap(spec.properties ?? {})
    return {
      type: 'object',
      properties: compiled.properties,
      ...(compiled.required === undefined ? {} : { required: compiled.required }),
    }
  }
  if (spec.type === 'array') {
    if (spec.items === undefined) throw new Error('defineTool: array node needs items')
    return { type: 'array', items: compileNode(spec.items) }
  }
  if (SCALARS.has(spec.type)) {
    const node = { type: spec.type }
    if (spec.enum !== undefined) node.enum = spec.enum
    if (spec.const !== undefined) node.const = spec.const
    return node
  }
  throw new Error(`defineTool: unsupported schema node type ${JSON.stringify(spec.type)}`)
}

function compilePropertyMap(spec) {
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec)) {
    const { required: isRequired, description, ...rest } = node ?? {}
    const compiled = compileNode(rest)
    if (typeof description === 'string' && description !== '') compiled.description = description
    properties[key] = compiled
    if (isRequired === true) required.push(key)
  }
  return { properties, ...(required.length === 0 ? {} : { required }) }
}

/**
 * Normalize one author-facing tool definition into a registry-ready definition.
 *
 * @param {object} options - name/description/parameters/output/execute/timeoutMs.
 * @returns {object} Definition with raw JSON Schema for parameters and output.
 */
export function defineTool(options) {
  if (typeof options?.name !== 'string' || options.name === '') throw new Error('defineTool: name is required')
  if (typeof options.output?.schema === 'undefined') throw new Error(`defineTool(${options.name}): output.schema is required`)
  if (typeof options.output?.render !== 'function') throw new Error(`defineTool(${options.name}): output.render is required`)
  const compiled = compilePropertyMap(options.parameters ?? {})
  const parameters = { type: 'object', properties: compiled.properties }
  if (compiled.required !== undefined) parameters.required = compiled.required

  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: compileNode(options.output.schema),
      render: options.output.render,
    },
    execute: options.execute,
  }
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) tool.timeoutMs = options.timeoutMs
  if (options.deferLoading === true) tool.deferLoading = true
  return tool
}
