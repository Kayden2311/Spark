import { PageTitle, WorkspaceShell } from "../components";
const events = [["09:30", "Founder stand-up", "Team room", "ML"], ["13:00", "Product Circle: Member session", "Online", "PC"], ["16:00", "Customer interview", "Zoom", "DK"]];
export default function SchedulePage() {
  return <WorkspaceShell current="Schedule"><PageTitle eyebrow="September 2026" title="Your week"><button className="button" type="button">+ New event</button></PageTitle><section className="weekGrid">{["Mon 14", "Tue 15", "Wed 16", "Thu 17", "Fri 18"].map((day, index) => <div className={index === 0 ? "day today" : "day"} key={day}><strong>{day}</strong><span>{index === 0 ? "Today" : ""}</span></div>)}</section><section className="scheduleList"><h2>Monday, 14 September</h2>{events.map(([time, title, place, owner]) => <article className="eventRow" key={title}><time>{time}</time><div><h3>{title}</h3><p>{place}</p></div><span className="avatar">{owner}</span></article>)}</section></WorkspaceShell>;
}
