export default function transform({ operation, response }) {
  if (response && response.body && typeof response.body === "object" && !Array.isArray(response.body)) {
    return { ...response.body, transformedBy: operation.operationId };
  }
  return { result: response.body, transformedBy: operation.operationId };
}
