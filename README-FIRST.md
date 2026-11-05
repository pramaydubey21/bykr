# bykr — read this before doing anything else

This folder contains the brief for a university Database Management Systems mini-project, plus reference material from a separate Software Engineering course that uses the same application concept.

## What to do

**Read `BYKR_ClaudeCode_Prompt.md` and follow it.** That file is the specification. Everything you build goes in this folder.

## Precedence — this matters

The folder contains two descriptions of the same application, written for two different courses, and **they specify different technology stacks on purpose**.

| Source | Stack it describes | Authority |
|---|---|---|
| `BYKR_ClaudeCode_Prompt.md` | Next.js, TypeScript, PostgreSQL with pgvector, MongoDB | **This is what you build.** |
| `reference/software-engineering/` | Kotlin, Ktor, Android | Reference only. Do not build this. |

The Software Engineering documents were written earlier for a different course with different constraints and were deliberately left unchanged. They are included because their requirement identifiers, use cases, entity descriptions and sequence diagrams are useful background on what the application does. **Ignore every technology choice in them.** Where they conflict with `BYKR_ClaudeCode_Prompt.md`, the prompt wins without exception.

In particular: do not write Kotlin, do not use Ktor, do not build an Android application, and do not treat the component diagram in the architecture document as the architecture to implement.

## What is in the reference folder

| File | Useful for |
|---|---|
| `BYKR_SRS_v1.0.docx` | Functional and non-functional requirements with identifiers, two detailed use case descriptions, security objectives and requirements. |
| `BYKR_Architecture_and_Design_v1.0.docx` | Entity descriptions, API shape, error model, design decisions and their rationale. Ignore the component and deployment sections. |
| `BYKR_Test_Plan_v1.0.docx` | Thirty test cases describing expected behaviour. Useful as acceptance criteria regardless of stack. |
| `diagrams/usecase.png` | The sixteen use cases and five actors. |
| `diagrams/seq_accident.png` | The accident detection and alert fan-out sequence. Still accurate as a description of the behaviour. |
| `diagrams/seq_location.png` | The live location broadcast sequence. Note that the prompt replaces the WebSocket channel with polling. |
| `diagrams/component.png` | Kotlin architecture. Superseded — included only for completeness. |
| `rubric/` | Photographs of the marking sheet this project is graded against. |

## Deliverables you produce

Build into this folder, following the repository layout in section 9 of the prompt. Initialise git here and commit incrementally. Write `RUBRIC.md` last and verify each claim against the files before you declare the work finished.
