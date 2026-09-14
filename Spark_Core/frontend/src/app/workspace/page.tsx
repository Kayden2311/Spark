import { PageTitle, WorkspaceShell } from "../components";

const columns: readonly (readonly [string, readonly string[]])[] = [["To do", ["Share demo with HN Founders", "Outline onboarding emails"]], ["In progress", ["Refine investor update", "Set up customer calls"]], ["Done", ["Choose Q3 metrics"]]];

export default function WorkspacePage() {
  return <WorkspaceShell current="Board"><PageTitle eyebrow="Northstar Founders" title="Product launch"><button className="button" type="button">+ Add task</button></PageTitle><section className="projectSummary"><div><span className="summaryLabel">This week</span><strong>6 tasks in motion</strong></div><div className="progress"><span style={{ width: "58%" }} /></div><span className="muted">58% complete</span></section><section className="board" aria-label="Product launch task board">{columns.map(([name, tasks]) => <div className="boardColumn" key={name}><header><h2>{name}</h2><span>{tasks.length}</span></header>{tasks.map((task, index) => <article className="taskCard" key={task}><span className={index === 0 ? "tag amber" : "tag green"}>{index === 0 ? "Growth" : "Product"}</span><h3>{task}</h3><footer><span className="avatar tiny">{index === 0 ? "ML" : "DK"}</span><span>{index === 0 ? "Fri" : "Next week"}</span></footer></article>)}<button className="addCard" type="button">+ Add a task</button></div>)}</section></WorkspaceShell>;
}
