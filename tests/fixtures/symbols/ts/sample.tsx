import React from "react";

/** Button component. */
export const Button = ({ label }: { label: string }) => <button>{label}</button>;

export function Panel(props: { title: string }) {
  return <div>{props.title}</div>;
}

export class Widget extends React.Component {
  render() {
    return <span />;
  }
}
