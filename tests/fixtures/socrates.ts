import {
  coveragePropertyCatalog,
  coverageToken,
} from "../../socrates/assessment.ts";
import { SpecStatus, specDraft } from "../../socrates/spec.ts";

export function readySpecification(revision: string) {
  const specification = {
    status: SpecStatus.Interrogating,
    version: 1,
    acceptedRevision: revision,
    draft: specDraft.parse({
      objective: "Retain the original transcript",
      scope: ["The current checkout"],
      requirements: [
        {
          id: "R1",
          outcome: "Recover the transcript",
          acceptance: "The recovered transcript matches the original bytes",
        },
      ],
      decisions: [],
      blockingQuestions: [],
      coverage: {
        domains: ["engineering"],
        assessments: coveragePropertyCatalog
          .filter(
            ({ domain }) => domain === "universal" || domain === "engineering",
          )
          .map(({ id, label }) => ({
            propertyId: id,
            status: id === "stakeholders" ? "not-applicable" : "satisfied",
            reason:
              id === "stakeholders"
                ? "The transcript belongs to the operator alone."
                : `The operator reviewed ${label} against R1.`,
          })),
      },
    }),
  };
  return { ...specification, coverageRevision: coverageToken(specification) };
}
