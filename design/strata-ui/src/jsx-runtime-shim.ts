// Radix ships compiled code that imports react/jsx-runtime; on the canvas React is the page's global.
import * as React from "react"

type Props = Record<string, unknown> | null

function jsx(type: React.ElementType, props: Props, key?: React.Key) {
  return React.createElement(type, key === undefined ? props : { ...props, key })
}

export { jsx, jsx as jsxs, jsx as jsxDEV }
export const Fragment = React.Fragment
