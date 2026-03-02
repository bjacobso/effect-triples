import type { TripleInput } from "@open-ontology/core";
import { string, number, boolean, datetime, ref } from "@open-ontology/core";

/**
 * Generate employee triples for stress testing.
 *
 * Creates a simple but realistic dataset of employee records with:
 * - 10 attributes per employee (name, email, age, salary, department, title, active, hire_date, location, manager)
 * - Realistic distributions (more junior than senior, salary correlates with level)
 * - 20% of employees have manager references (creates graph structure)
 *
 * @param count Number of employees to generate
 * @returns Array of TripleInput objects (count * 10 triples, or count * 11 for employees with managers)
 */
export function generateEmployeeTriples(count: number): TripleInput[] {
  const triples: TripleInput[] = [];

  const departments = [
    "Engineering",
    "Sales",
    "Marketing",
    "HR",
    "Finance",
    "Operations",
    "Legal",
    "Support",
  ];

  const titles = ["Junior", "Mid-Level", "Senior", "Staff", "Lead", "Principal"];

  const locations = ["NYC", "SF", "Austin", "Remote", "London"];

  for (let i = 0; i < count; i++) {
    const empId = `emp:${i}`;

    // Distribute across departments evenly
    const deptIdx = i % departments.length;

    // More juniors than seniors (realistic distribution)
    // 0-19,999: Junior
    // 20,000-39,999: Mid-Level
    // 40,000-59,999: Senior
    // 60,000-79,999: Staff
    // 80,000-99,999: Lead/Principal
    const titleIdx = Math.min(Math.floor(i / 20000), titles.length - 1);

    // Age: 25-65, cyclic distribution
    const age = 25 + (i % 40);

    // Salary: Base + level bonus + variation
    // Junior: $50k-$100k
    // Mid: $75k-$125k
    // Senior: $100k-$150k
    // Staff: $125k-$175k
    // Lead: $150k-$200k
    // Principal: $175k-$225k
    const baseSalary = 50000 + titleIdx * 25000 + (i % 50000);

    // Core attributes (9 per employee)
    triples.push(
      {
        entityId: empId,
        attribute: ":name",
        value: string(`Employee-${i}`),
        entityType: "Employee",
      },
      {
        entityId: empId,
        attribute: ":email",
        value: string(`emp${i}@company.com`),
      },
      {
        entityId: empId,
        attribute: ":age",
        value: number(age),
      },
      {
        entityId: empId,
        attribute: ":salary",
        value: number(baseSalary),
      },
      {
        entityId: empId,
        attribute: ":department",
        value: string(departments[deptIdx]!),
      },
      {
        entityId: empId,
        attribute: ":title",
        value: string(titles[titleIdx]!),
      },
      {
        entityId: empId,
        attribute: ":active",
        value: boolean(i % 10 !== 0), // 90% active
      },
      {
        entityId: empId,
        attribute: ":hire_date",
        value: datetime(Date.now() - i * 86400000), // Distributed over past days
      },
      {
        entityId: empId,
        attribute: ":location",
        value: string(locations[i % 5]!),
      },
    );

    // 20% have manager references (creates graph structure for relationship queries)
    if (i > 0 && i % 5 === 0) {
      const managerId = Math.max(0, i - 10 - (i % 10));
      triples.push({
        entityId: empId,
        attribute: ":manager",
        value: ref(`emp:${managerId}`),
      });
    }
  }

  return triples;
}
