export const virtualMarker = "local-typebox-root";
export const Type = {
  String() {
    return { type: "string", adapterLocalFake: true };
  },
  Literal(value) {
    return { const: value, adapterLocalFake: true };
  },
  Object(properties) {
    return { type: "object", properties, adapterLocalFake: true };
  },
  Union(anyOf) {
    return { anyOf, adapterLocalFake: true };
  },
};
export function IsSchema(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
