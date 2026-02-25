import "./StatCard.css";

export default function StatCard({ title, value, icon }) {
  return (
    <div className="statCardNeon glass-card">
      <div className="flex items-center gap-2 statCardTitle mb-2">
        {icon}
        {title}
      </div>

      <div className="statCardValue">{value}</div>
    </div>
  );
}
