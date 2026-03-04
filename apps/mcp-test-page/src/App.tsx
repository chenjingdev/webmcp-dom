import { useState } from 'react'

export default function App() {
  const [count, setCount] = useState(0)
  const [count2, setCount2] = useState(0)

  return (
    <div
      data-mcp-group="navigation"
      data-mcp-tool-name="navigation_click"
      data-mcp-tool-desc="카운트 증가 버튼 모음"
    >
      <button
        data-mcp-action="click"
        data-mcp-name="1"
        data-mcp-desc="1씩 증가"
        onClick={() => setCount((value) => value + 1)}
      >
        count is {count}
      </button>
      <button
        data-mcp-action="click"
        data-mcp-name="2"
        data-mcp-desc="2씩 증가"
        onClick={() => setCount2((value) => value + 2)}
      >
        count is {count2}
      </button>
    </div>
  )
}
