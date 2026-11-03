import { findLesson } from '../content';
import { Header } from './Header';
import { InterviewView } from './interview/InterviewView';
import { LessonView, ReviewView } from './lesson/LessonView';
import { Profile } from './profile/Profile';
import { Sandbox } from './sandbox/Sandbox';
import { useRoute } from './router';
import { SkillTree } from './tree/SkillTree';

export function App() {
  const route = useRoute();
  let body;
  if (route.view === 'lesson') {
    const lesson = findLesson(route.lessonId);
    body =
      lesson && route.mission < lesson.missions.length ? (
        <LessonView lesson={lesson} missionIndex={route.mission} />
      ) : (
        <div className="locked-screen">
          <h2>Lesson not found</h2>
          <a href="#/tree">Back to the skill tree</a>
        </div>
      );
  } else if (route.view === 'profile') {
    body = <Profile />;
  } else if (route.view === 'sandbox') {
    body = <Sandbox />;
  } else if (route.view === 'interview') {
    body = <InterviewView />;
  } else if (route.view === 'review') {
    body = <ReviewView missionId={route.missionId} />;
  } else {
    body = <SkillTree />;
  }
  return (
    <div className="app">
      <Header route={route} />
      {body}
    </div>
  );
}
